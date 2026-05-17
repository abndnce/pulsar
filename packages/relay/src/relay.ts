import {
  decryptSignal,
  encryptSignal,
  generateNostrKeypair,
  isAddressedTo,
  makeDiscoveryEvent,
  makeSignalEvent,
  makeSignalingFilter,
  NOSTR_RELAYS,
  type NostrKeypair,
  parseNostrMessage,
  sendNostrEvent,
  sendNostrReq,
  SIGNALING_KIND,
  type SignalingPayload,
  type SignedNostrEvent,
  signNostrEvent,
  tunnelCodeFromPubkey,
  verifyNostrEvent,
} from "../../core/nostr.ts";
import { DEFAULT_ICE_SERVERS, waitForIceGathering } from "../../core/webrtc.ts";
import { KEEPALIVE_LABEL } from "../../core/constants.ts";
import {
  parseSocketDestination,
  type SocketDestination,
} from "../../core/socket.ts";
import { WispClient } from "./wisp-client";

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
  tunnelCode?: string;
};

type NostrConnection = {
  ws: WebSocket;
  url: string;
};

export class PulsarRelay {
  private nostrConns: NostrConnection[] = [];
  private wisp: WispClient | null = null;
  private keypair: NostrKeypair | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private seenEventIds = new Set<string>();
  private nostrStatuses: NostrConnStatus[] = [];
  private phase: RelayPhase = "idle";
  private detail = "";
  private tunnelCode: string | undefined;
  private onUpdate: ((update: RelayUpdate) => void) | null = null;

  get currentPhase() {
    return this.phase;
  }

  get currentDetail() {
    return this.detail;
  }

  get currentTunnelCode() {
    return this.tunnelCode;
  }

  get currentNostrStatuses() {
    return this.nostrStatuses;
  }

  setUpdateCallback(cb: (update: RelayUpdate) => void) {
    this.onUpdate = cb;
  }

  async start(wispUrl: string): Promise<void> {
    this.closeConnections();
    this.keypair = generateNostrKeypair();
    this.tunnelCode = tunnelCodeFromPubkey(this.keypair.pubkey);
    this.seenEventIds.clear();

    try {
      this.setPhase("connecting-nostr", "Connecting to Nostr relays...");
      await this.connectNostrRelays();

      if (!this.nostrConns.length) {
        throw new Error("Could not connect to any Nostr relay");
      }

      this.setPhase("connecting-wisp", "Connecting to Wisp server...");
      this.wisp = new WispClient(wispUrl);
      this.wisp.onclose = () => {
        if (this.phase !== "idle" && this.phase !== "failed") {
          this.setPhase("failed", "Wisp server disconnected");
        }
      };
      await this.wisp.connected;

      await this.publishDiscovery();
      for (const conn of this.nostrConns) this.subscribeSignaling(conn);

      this.setPhase("ready", "Relay is active");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setPhase("failed", message);
      this.closeConnections({ keepStatus: true });
      throw err;
    }
  }

  stop() {
    this.closeConnections();
    this.keypair = null;
    this.tunnelCode = undefined;
    this.nostrStatuses = [];
    this.setPhase("idle", "");
  }

  private async connectNostrRelays(): Promise<void> {
    this.nostrStatuses = NOSTR_RELAYS.map((url) => ({
      url,
      state: "connecting",
    }));
    this.emit();

    await Promise.allSettled(
      NOSTR_RELAYS.map((url) => this.connectOneNostr(url)),
    );
    this.emit();
  }

  private connectOneNostr(url: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        this.updateNostrStatus(url, { state: "failed", error: "Timed out" });
        ws.close();
        resolve();
      }, 8_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.nostrConns.push({ ws, url });
        this.updateNostrStatus(url, { state: "connected", error: undefined });
        resolve();
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        this.updateNostrStatus(url, {
          state: "failed",
          error: "Connection error",
        });
        resolve();
      });

      ws.addEventListener("close", () => {
        const idx = this.nostrConns.findIndex((conn) => conn.ws === ws);
        if (idx !== -1) this.nostrConns.splice(idx, 1);
        this.updateNostrStatus(url, {
          state: "failed",
          error: "Disconnected",
        });

        if (this.phase === "ready" && !this.nostrConns.length) {
          this.setPhase("failed", "All Nostr relays disconnected");
        }
      });
    });
  }

  private async publishDiscovery(): Promise<void> {
    if (!this.keypair) throw new Error("Missing relay keypair");

    const discovery = await signNostrEvent(
      makeDiscoveryEvent(this.keypair.pubkey),
      this.keypair.seckey,
    );
    for (const conn of this.nostrConns) sendNostrEvent(conn.ws, discovery);
  }

  private subscribeSignaling(conn: NostrConnection): void {
    if (!this.keypair) throw new Error("Missing relay keypair");

    const subId = `pulsar-signal-${this.keypair.pubkey.slice(0, 8)}`;
    sendNostrReq(conn.ws, subId, makeSignalingFilter(this.keypair.pubkey));

    conn.ws.addEventListener("message", (event) => {
      const msg = parseNostrMessage(event.data);
      if (!msg || msg[0] !== "EVENT" || msg[1] !== subId) return;

      this.handleSignalingEvent(msg[2], conn.ws).catch((err) => {
        console.error("[relay] Failed to handle signaling event", err);
      });
    });
  }

  private async handleSignalingEvent(
    event: SignedNostrEvent,
    relayWs: WebSocket,
  ): Promise<void> {
    if (!this.keypair) return;
    if (this.seenEventIds.has(event.id)) return;
    if (event.kind !== SIGNALING_KIND) return;
    if (!isAddressedTo(event, this.keypair.pubkey)) return;
    if (!await verifyNostrEvent(event)) return;

    this.seenEventIds.add(event.id);

    let payload: SignalingPayload;
    try {
      payload = JSON.parse(
        await decryptSignal(event.content, this.keypair.seckey, event.pubkey),
      ) as SignalingPayload;
    } catch (err) {
      console.error("[relay] Could not decrypt signaling event", err);
      return;
    }

    if (payload.type === "offer" && payload.sdp) {
      await this.handleOffer(event.pubkey, payload.sdp, relayWs);
      return;
    }

    if (payload.type === "ice" && payload.candidate) {
      await this.handleIceCandidate(event.pubkey, payload);
    }
  }

  private async handleOffer(
    clientPubkey: string,
    sdp: string,
    relayWs: WebSocket,
  ): Promise<void> {
    if (!this.keypair) throw new Error("Missing relay keypair");

    const previous = this.peerConnections.get(clientPubkey);
    if (previous) {
      try {
        previous.close();
      } catch {
        /* ignore */
      }
    }

    const pc = new RTCPeerConnection({ iceServers: [...DEFAULT_ICE_SERVERS] });
    this.peerConnections.set(clientPubkey, pc);

    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.peerConnections.delete(clientPubkey);
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
    });
    pc.ondatachannel = (event) => this.handleDataChannel(event.channel);

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    const localDesc = pc.localDescription;
    if (!localDesc) throw new Error("Missing local description");

    const encrypted = await encryptSignal(
      JSON.stringify(
        { type: "answer", sdp: localDesc.sdp } satisfies SignalingPayload,
      ),
      this.keypair.seckey,
      clientPubkey,
    );
    const answerEvent = await signNostrEvent(
      makeSignalEvent(this.keypair.pubkey, clientPubkey, encrypted),
      this.keypair.seckey,
    );
    sendNostrEvent(relayWs, answerEvent);
    this.setPhase("ready", "Accepted a Pulsar connection");
  }

  private async handleIceCandidate(
    clientPubkey: string,
    payload: SignalingPayload,
  ): Promise<void> {
    const pc = this.peerConnections.get(clientPubkey);
    if (!pc || !payload.candidate) return;

    await pc.addIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid ?? "0",
      sdpMLineIndex: payload.sdpMLineIndex ?? 0,
    });
  }

  private handleDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    if (channel.label === KEEPALIVE_LABEL) return;

    let destination: SocketDestination;
    try {
      destination = parseSocketDestination(channel.label);
    } catch {
      channel.close();
      return;
    }

    const wisp = this.wisp;
    if (!wisp) {
      channel.close();
      return;
    }

    let stream;
    try {
      stream = wisp.connect(destination.hostname, destination.port);
    } catch {
      channel.close();
      return;
    }

    stream.ondata = (data) => {
      if (channel.readyState === "open") channel.send(data);
    };
    stream.onclose = () => closeDataChannel(channel);

    channel.onmessage = (event) => {
      try {
        stream.sendToStream(toUint8Array(event.data));
      } catch {
        stream.close(0x03);
        closeDataChannel(channel);
      }
    };
    channel.onclose = () => stream.close(0x02);
    channel.onerror = () => stream.close(0x03);
  }

  private updateNostrStatus(url: string, patch: Partial<NostrConnStatus>) {
    const idx = this.nostrStatuses.findIndex((status) => status.url === url);
    if (idx === -1) return;

    this.nostrStatuses[idx] = { ...this.nostrStatuses[idx], ...patch };
    this.emit();
  }

  private setPhase(phase: RelayPhase, detail: string) {
    this.phase = phase;
    this.detail = detail;
    this.emit();
  }

  private emit() {
    this.onUpdate?.({
      phase: this.phase,
      detail: this.detail,
      nostrStatuses: this.nostrStatuses,
      tunnelCode: this.tunnelCode,
    });
  }

  private closeConnections(options: { keepStatus?: boolean } = {}) {
    for (const conn of this.nostrConns) {
      try {
        conn.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.nostrConns.length = 0;

    this.wisp?.close();
    this.wisp = null;

    for (const pc of this.peerConnections.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peerConnections.clear();

    if (!options.keepStatus) this.nostrStatuses = [];
  }
}

function closeDataChannel(channel: RTCDataChannel): void {
  if (channel.readyState === "closed" || channel.readyState === "closing") {
    return;
  }
  channel.close();
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new Error("Unsupported data channel payload");
}
