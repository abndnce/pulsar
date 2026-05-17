/**
 * Pulsar browser relay — bridges Nostr relays + Wisp server.
 *
 * 1. Auto-connects to upstream Nostr relays for event relaying
 * 2. Connects to a user-provided Wisp server for TCP stream multiplexing
 * 3. Generates a tunnel code so clients can discover and connect
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1";

// ── Types ─────────────────────────────────────────────────────────

interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  "#d"?: string[];
  "#p"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

// ── Constants ─────────────────────────────────────────────────────

const NOSTR_RELAYS = [
  "wss://nostr.data.haus",
  "wss://kotukonostr.onrender.com",
];

// ── Hex helpers ───────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Nostr event store ────────────────────────────────────────────

class EventStore {
  private events: SignedNostrEvent[] = [];

  add(event: SignedNostrEvent): boolean {
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      const idx = this.events.findIndex(
        (e) =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          (e.tags.find((t) => t[0] === "d")?.[1] ?? "") === dTag,
      );
      if (idx !== -1) {
        if (event.created_at <= this.events[idx]!.created_at) return false;
        this.events[idx] = event;
        return true;
      }
    }
    if (this.events.some((e) => e.id === event.id)) return false;
    this.events.push(event);
    return true;
  }

  query(filter: NostrFilter): SignedNostrEvent[] {
    let results = this.events;
    if (filter.ids) results = results.filter((e) => filter.ids!.includes(e.id));
    if (filter.authors) results = results.filter((e) => filter.authors!.includes(e.pubkey));
    if (filter.kinds) results = results.filter((e) => filter.kinds!.includes(e.kind));
    if (filter["#d"]) {
      results = results.filter((e) =>
        e.tags.some((t) => t[0] === "d" && filter["#d"]!.includes(t[1])),
      );
    }
    if (filter["#p"]) {
      results = results.filter((e) =>
        e.tags.some((t) => t[0] === "p" && filter["#p"]!.includes(t[1])),
      );
    }
    if (filter.since) results = results.filter((e) => e.created_at >= filter.since!);
    if (filter.until) results = results.filter((e) => e.created_at <= filter.until!);
    results = [...results].sort((a, b) => b.created_at - a.created_at);
    if (filter.limit && filter.limit > 0) results = results.slice(0, filter.limit);
    return results;
  }

  get size(): number {
    return this.events.length;
  }
}

// ── Relay status types ───────────────────────────────────────────

export type RelayPhase =
  | "idle"
  | "connecting-wisp"
  | "connecting-nostr"
  | "ready"
  | "failed";

export type NostrConnStatus = {
  url: string;
  state: "connecting" | "connected" | "failed";
  error?: string;
};

export type RelayUpdate = {
  phase: RelayPhase;
  detail: string;
  nostrStatuses: NostrConnStatus[];
  eventCount: number;
  tunnelCode?: string;
};

// ── Wisp client ──────────────────────────────────────────────────

const PACKET_TYPE_CONNECT = 0x01;
const PACKET_TYPE_DATA = 0x02;
const PACKET_TYPE_CONTINUE = 0x03;
const PACKET_TYPE_CLOSE = 0x04;
const PACKET_TYPE_INFO = 0x05;
const STREAM_TYPE_TCP = 0x01;

class WispStream {
  readonly streamId: number;
  private bufferRemaining = 0;
  private pendingData: Uint8Array[] = [];
  private send: (type: number, streamId: number, payload: Uint8Array) => void;
  private _closed = false;

  ondata: ((data: Uint8Array) => void) | null = null;
  onclose: ((reason?: number) => void) | null = null;

  constructor(
    streamId: number,
    initialBuffer: number,
    send: (type: number, streamId: number, payload: Uint8Array) => void,
  ) {
    this.streamId = streamId;
    this.bufferRemaining = initialBuffer;
    this.send = send;
  }

  grantBuffer(size: number) {
    this.bufferRemaining += size;
    this.flushPending();
  }

  receiveData(data: Uint8Array) {
    this.ondata?.(data);
  }

  close(reason = 0x01) {
    if (this._closed) return;
    this._closed = true;
    this.send(PACKET_TYPE_CLOSE, this.streamId, new Uint8Array([reason]));
    this.onclose?.(reason);
  }

  sendToStream(data: Uint8Array) {
    if (this._closed) return;
    if (this.bufferRemaining > 0) {
      this.bufferRemaining--;
      this.send(PACKET_TYPE_DATA, this.streamId, data);
    } else {
      this.pendingData.push(data);
    }
  }

  remoteClose(reason: number) {
    if (this._closed) return;
    this._closed = true;
    this.onclose?.(reason);
  }

  private flushPending() {
    while (this.bufferRemaining > 0 && this.pendingData.length > 0) {
      const data = this.pendingData.shift()!;
      this.bufferRemaining--;
      this.send(PACKET_TYPE_DATA, this.streamId, data);
    }
  }
}

class WispClient {
  private ws: WebSocket;
  private streams = new Map<number, WispStream>();
  private initialBuffer = 0;
  private handshakeComplete = false;
  private handshakeResolve: ((value: void) => void) | null = null;
  private handshakeReject: ((reason: Error) => void) | null = null;
  private usedStreamIds = new Set<number>();

  onclose: (() => void) | null = null;
  readonly connected: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url, "wisp");
    this.ws.binaryType = "arraybuffer";

    const handshake = new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    this.connected = handshake;

    this.ws.onopen = () => {};
    this.ws.onmessage = (event) => this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
    this.ws.onclose = () => {
      for (const s of this.streams.values()) s.remoteClose(0x03);
      this.streams.clear();
      this.onclose?.();
      if (!this.handshakeComplete) this.handshakeReject?.(new Error("WebSocket closed during handshake"));
    };
    this.ws.onerror = () => {
      if (!this.handshakeComplete) this.handshakeReject?.(new Error("WebSocket error during handshake"));
    };
  }

  connect(hostname: string, port: number): WispStream {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Wisp not open");
    const streamId = this.genId();
    const stream = new WispStream(streamId, this.initialBuffer, (t, id, p) => this.sendPacket(t, id, p));
    this.streams.set(streamId, stream);
    const hostBytes = new TextEncoder().encode(hostname);
    const payload = new Uint8Array(3 + hostBytes.length);
    const view = new DataView(payload.buffer);
    payload[0] = STREAM_TYPE_TCP;
    view.setUint16(1, port, true);
    payload.set(hostBytes, 3);
    this.sendPacket(PACKET_TYPE_CONNECT, streamId, payload);
    return stream;
  }

  close() {
    for (const s of this.streams.values()) s.close(0x02);
    this.streams.clear();
    this.ws.close();
  }

  private genId(): number {
    let id: number;
    do {
      id = crypto.getRandomValues(new Uint32Array(1))[0]!;
    } while (id === 0 || this.usedStreamIds.has(id));
    this.usedStreamIds.add(id);
    return id;
  }

  private sendPacket(type: number, streamId: number, payload: Uint8Array) {
    const pkt = new Uint8Array(5 + payload.length);
    const v = new DataView(pkt.buffer);
    pkt[0] = type;
    v.setUint32(1, streamId, true);
    pkt.set(payload, 5);
    this.ws.send(pkt);
  }

  private handleMessage(data: Uint8Array) {
    if (data.length < 5) return;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = data[0]!;
    const streamId = v.getUint32(1, true);
    const payload = data.subarray(5);
    switch (type) {
      case PACKET_TYPE_INFO:
        if (payload.length < 2) return;
        this.sendPacket(PACKET_TYPE_INFO, 0, new Uint8Array([2, 1]));
        break;
      case PACKET_TYPE_CONTINUE:
        if (streamId === 0 && !this.handshakeComplete) {
          const b = payload.length >= 4 ? v.getUint32(5, true) : 64;
          this.initialBuffer = b;
          this.handshakeComplete = true;
          this.handshakeResolve?.();
        } else {
          this.streams.get(streamId)?.grantBuffer(payload.length >= 4 ? v.getUint32(5, true) : 0);
        }
        break;
      case PACKET_TYPE_DATA:
        this.streams.get(streamId)?.receiveData(payload);
        break;
      case PACKET_TYPE_CLOSE:
        if (streamId === 0 && !this.handshakeComplete) {
          this.handshakeReject?.(new Error("Server rejected handshake"));
        } else {
          const reason = payload.length > 0 ? payload[0] : 0x01;
          this.streams.get(streamId)?.remoteClose(reason);
          this.streams.delete(streamId);
        }
        break;
    }
  }
}

// ── Wisp client adapter for WebRTC ───────────────────────────────

class WispToRtcBridge {
  private wisp: WispClient;
  private pending = new Map<string, { hostname: string; port: number }>();

  constructor(wispUrl: string) {
    this.wisp = new WispClient(wispUrl);
  }

  get connected(): Promise<void> {
    return this.wisp.connected;
  }

  get onclose() {
    return this.wisp.onclose;
  }

  set onclose(fn: (() => void) | null) {
    this.wisp.onclose = fn;
  }

  openTunnel(hostname: string, port: number): { send: (data: Uint8Array) => void; ondata: (cb: (data: Uint8Array) => void) => void; close: () => void } {
    const stream = this.wisp.connect(hostname, port);
    let dataCb: ((data: Uint8Array) => void) | null = null;
    stream.ondata = (data) => dataCb?.(data);
    return {
      send: (data) => stream.sendToStream(data),
      ondata: (cb) => { dataCb = cb; },
      close: () => stream.close(),
    };
  }

  close() {
    this.wisp.close();
  }
}

// ── PulsarRelay ──────────────────────────────────────────────────

export class PulsarRelay {
  private nostrConns: { ws: WebSocket; url: string }[] = [];
  private wisp: WispToRtcBridge | null = null;
  private store = new EventStore();
  private _nostrStatuses: NostrConnStatus[] = [];
  private _phase: RelayPhase = "idle";
  private _detail = "";
  private _tunnelCode: string | undefined;
  private onUpdate: ((update: RelayUpdate) => void) | null = null;

  get phase() { return this._phase; }
  get detail() { return this._detail; }
  get tunnelCode() { return this._tunnelCode; }
  get nostrStatuses() { return this._nostrStatuses; }
  get eventCount() { return this.store.size; }

  setUpdateCallback(cb: (update: RelayUpdate) => void) {
    this.onUpdate = cb;
  }

  private setPhase(phase: RelayPhase, detail: string) {
    this._phase = phase;
    this._detail = detail;
    this.emit();
  }

  private emit() {
    this.onUpdate?.({
      phase: this._phase,
      detail: this._detail,
      nostrStatuses: this._nostrStatuses,
      eventCount: this.store.size,
      tunnelCode: this._tunnelCode,
    });
  }

  /**
   * Start the relay: connect to Nostr relays + Wisp server.
   */
  async start(wispUrl: string): Promise<void> {
    this._tunnelCode = undefined;

    // Phase 1: connect to Nostr relays (auto, defaults)
    this.setPhase("connecting-nostr", "Connecting to Nostr relays\u2026");
    await this.connectNostrRelays();

    // Check at least one Nostr relay connected
    const anyConnected = this._nostrStatuses.some((s) => s.state === "connected");
    if (!anyConnected) {
      this.setPhase("failed", "Could not connect to any Nostr relay");
      return;
    }

    // Phase 2: connect to Wisp server
    this.setPhase("connecting-wisp", "Connecting to Wisp server\u2026");

    try {
      this.wisp = new WispToRtcBridge(wispUrl);
      await this.wisp.connected;
    } catch (err) {
      this.setPhase("failed", `Wisp connection failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.wisp.onclose = () => {
      if (this._phase !== "failed") {
        this.setPhase("failed", "Wisp server disconnected");
      }
    };

    // Generate tunnel code from pubkey
    const seckey = secp256k1.utils.randomPrivateKey();
    const fullPub = secp256k1.getPublicKey(seckey, true);
    const pubkey = fullPub.slice(1);
    const pubkeyHex = bytesToHex(pubkey);
    this._tunnelCode = "pulsar" + pubkeyHex.slice(0, 4);

    this.setPhase("ready", "Relay is active");
  }

  private async connectNostrRelays(): Promise<void> {
    this._nostrStatuses = NOSTR_RELAYS.map((url) => ({ url, state: "connecting" as const }));
    this.emit();

    const promises = NOSTR_RELAYS.map((url) => this.connectOneNostr(url));
    await Promise.allSettled(promises);
    this.emit();
  }

  private connectOneNostr(url: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
          this.updateNostrStatus(url, { state: "failed", error: "Timed out" });
          ws.close();
          resolve();
        }, 8000);

        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          this.nostrConns.push({ ws, url });
          this.updateNostrStatus(url, { state: "connected" });

          // Subscribe to everything
          const subId = "relay-all-" + url.replace(/[^a-z0-9]/g, "");
          ws.send(JSON.stringify(["REQ", subId, { kinds: [], limit: 0 }]));

          resolve();
        });

        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          this.updateNostrStatus(url, { state: "failed", error: "Connection error" });
          resolve();
        });

        ws.addEventListener("close", () => {
          const idx = this.nostrConns.findIndex((c) => c.url === url);
          if (idx !== -1) this.nostrConns.splice(idx, 1);
          this.updateNostrStatus(url, { state: "failed", error: "Disconnected" });
        });

        ws.addEventListener("message", (event) => {
          this.handleNostrMsg(url, event.data);
        });
      } catch (err) {
        this.updateNostrStatus(url, {
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        resolve();
      }
    });
  }

  private updateNostrStatus(url: string, patch: Partial<NostrConnStatus>) {
    const idx = this._nostrStatuses.findIndex((s) => s.url === url);
    if (idx !== -1) {
      this._nostrStatuses[idx] = { ...this._nostrStatuses[idx], ...patch };
      this.emit();
    }
  }

  private handleNostrMsg(url: string, data: string) {
    let msg: any[];
    try { msg = JSON.parse(data); } catch { return; }
    if (msg[0] === "EVENT") {
      const event = msg[2] as SignedNostrEvent;
      if (!event.id || !event.sig) return;
      if (this.store.add(event)) this.emit();
    }
  }

  /**
   * Stop the relay and disconnect everything.
   */
  stop() {
    for (const conn of this.nostrConns) {
      try { conn.ws.close(); } catch { /* ignore */ }
    }
    this.nostrConns.length = 0;
    this.wisp?.close();
    this.wisp = null;
    this.store = new EventStore();
    this._nostrStatuses = [];
    this._tunnelCode = undefined;
    this.setPhase("idle", "");
  }
}
