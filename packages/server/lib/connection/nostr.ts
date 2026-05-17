import { Buffer } from "node:buffer";
import { RTCPeerConnection } from "npm:werift";
import {
  NOSTR_RELAYS,
  SIGNALING_KIND,
  DISCOVERY_KIND,
  D_TAG_ID,
  tunnelCodeFromPubkey,
  type SignedNostrEvent,
  type NostrFilter,
} from "../../../core/nostr.ts";
import { wireTunnel, type TunnelWireTarget } from "../tunnel.ts";
import type { PulsarServerConnection } from "./types.ts";

// ── secp256k1 crypto ─────────────────────────────────────────────

import { secp256k1, schnorr } from "@noble/curves/secp256k1";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Key generation ────────────────────────────────────────────────

function generateKeypair(): { seckey: string; pubkey: string } {
  const seckey = secp256k1.utils.randomPrivateKey();
  // Nostr pubkeys are 32-byte x-only (BIP-340 Schnorr)
  const fullPub = secp256k1.getPublicKey(seckey, true);
  const pubkey = fullPub.slice(1); // strip 0x02/0x03 prefix
  return {
    seckey: bytesToHex(seckey),
    pubkey: bytesToHex(pubkey),
  };
}

// ── NIP-44 encryption (AES-GCM with ECDH key exchange) ────────────

/**
 * Derive a shared ECDH secret between a private key and a peer's
 * 32-byte x-only public key (Nostr format).
 *
 * Schnorr public keys always have even y, so we reconstruct the
 * full point via ProjectivePoint and do scalar multiplication.
 */
function getSharedXOnly(seckey: Uint8Array, pubkeyXOnly: Uint8Array): Uint8Array {
  // Reconstruct full point from x-only by prepending even-y prefix (0x02)
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(pubkeyXOnly, 1);
  const pubPoint = secp256k1.ProjectivePoint.fromHex(compressed);
  const scalar = bytesToBigInt(seckey);
  const shared = pubPoint.multiply(scalar);
  return new Uint8Array(shared.toRawBytes(false).slice(1, 33));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt("0x" + hex);
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

async function getConversationKey(
  seckeyBytes: Uint8Array,
  pubkeyBytes: Uint8Array,
): Promise<CryptoKey> {
  const sharedSecret = toBufferSource(getSharedXOnly(seckeyBytes, pubkeyBytes));

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("nip44-v2"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function nip44Encrypt(
  plaintext: string,
  seckeyHex: string,
  pubkeyHex: string,
): Promise<string> {
  const seckey = hexToBytes(seckeyHex);
  const pubkey = hexToBytes(pubkeyHex);
  const convKey = await getConversationKey(seckey, pubkey);

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    convKey,
    encoded,
  );

  const result = new Uint8Array(1 + 12 + encrypted.byteLength);
  result[0] = 2;
  result.set(nonce, 1);
  result.set(new Uint8Array(encrypted), 13);

  return btoa(String.fromCharCode(...result));
}

async function nip44Decrypt(
  ciphertextB64: string,
  seckeyHex: string,
  pubkeyHex: string,
): Promise<string> {
  const seckey = hexToBytes(seckeyHex);
  const pubkey = hexToBytes(pubkeyHex);
  const convKey = await getConversationKey(seckey, pubkey);

  const raw = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  if (raw.length < 13) throw new Error("Ciphertext too short");

  const nonce = raw.slice(1, 13);
  const ciphertext = raw.slice(13);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    convKey,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// ── Nostr event helpers ───────────────────────────────────────────

function serializeEvent(ev: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

async function computeEventId(ev: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeEvent(ev)),
  );
  return bytesToHex(new Uint8Array(hash));
}

async function signEvent(
  ev: {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  },
  seckey: Uint8Array,
): Promise<SignedNostrEvent> {
  const id = await computeEventId(ev);
  const sig = schnorr.sign(hexToBytes(id), seckey);
  return {
    ...ev,
    id,
    sig: bytesToHex(sig),
  } as SignedNostrEvent;
}

// ── Signaling payload types ───────────────────────────────────────

interface SignalingPayload {
  type: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

// ── Default ICE servers ───────────────────────────────────────────

const defaultIceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

const keepaliveLabel = "keepalive";

// ── NostrServerConnection ─────────────────────────────────────────

/**
 * A Pulsar connection that was established via Nostr signaling.
 */
export class NostrServerConnection implements PulsarServerConnection, TunnelWireTarget {
  readonly tcpSockets = new Set<Deno.Conn>();

  constructor(
    public readonly dtlsTransport: any,
    public readonly sctpTransport: any,
    public readonly keepalive: any,
    private _pc: RTCPeerConnection,
  ) {}

  trackSocket(socket: Deno.Conn): void {
    this.tcpSockets.add(socket);
  }

  async close() {
    for (const sock of this.tcpSockets) {
      try { sock.close(); } catch { /* ignore */ }
    }
    this.tcpSockets.clear();
    try { this._pc.close(); } catch { /* ignore */ }
  }
}

// ── PulsarNostrServer ─────────────────────────────────────────────

/**
 * Pulsar server that uses Nostr relays for WebRTC signaling.
 *
 * On boot:
 * 1. Generates a fresh secp256k1 keypair
 * 2. Connects to all configured Nostr relays
 * 3. Publishes a NIP-33 discovery event (Kind 38000, d="pulsar-server")
 * 4. Subscribes to ephemeral signaling events (Kind 28000) targeted at its pubkey
 * 5. When an encrypted offer arrives: decrypts, creates a werift RTCPeerConnection,
 *    generates an answer, encrypts it, and replies via Nostr
 * 6. Wires the resulting tunnel
 */
export class PulsarNostrServer {
  private _seckey: string = "";
  private _pubkey: string = "";
  private _wsConnections: WebSocket[] = [];
  private _peerConnections = new Map<string, RTCPeerConnection>();
  private _shuttingDown = false;

  /** Called when a new tunnel connection is established. */
  onconnection: ((conn: NostrServerConnection) => void) | null = null;

  /** Called on errors. */
  onerror: ((err: Error) => void) | null = null;

  async start(): Promise<{ pubkey: string }> {
    // Generate keypair
    const keypair = generateKeypair();
    this._seckey = keypair.seckey;
    this._pubkey = keypair.pubkey;

    console.log(`[nostr] Server pubkey: ${this._pubkey}`);
    console.log(`[nostr] Tunnel code: ${tunnelCodeFromPubkey(this._pubkey)}`);

    // Connect to all relays in parallel
    const errors: Error[] = [];
    const connectPromises = NOSTR_RELAYS.map((relayUrl) =>
      this._connectToRelay(relayUrl).catch((err) => {
        errors.push(err);
        console.error(`[nostr] Failed to connect to ${relayUrl}: ${err.message}`);
      }),
    );

    await Promise.all(connectPromises);

    if (this._wsConnections.length === 0) {
      throw new Error(
        `Failed to connect to any Nostr relay: ${errors.map((e) => e.message).join("; ")}`,
      );
    }

    console.log(`[nostr] Connected to ${this._wsConnections.length} relay(s)`);

    // Publish discovery event on all connected relays
    await this._publishDiscovery();

    // Subscribe to signaling events on all relays
    for (const ws of this._wsConnections) {
      this._subscribeSignaling(ws);
    }

    return { pubkey: this._pubkey };
  }

  private async _connectToRelay(relayUrl: string): Promise<void> {
    const ws = new WebSocket(relayUrl);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${relayUrl} timed out`));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error connecting to ${relayUrl}`));
      });
    });

    ws.addEventListener("close", () => {
      console.warn(`[nostr] Disconnected from ${relayUrl}`);
      const idx = this._wsConnections.indexOf(ws);
      if (idx !== -1) this._wsConnections.splice(idx, 1);
    });

    this._wsConnections.push(ws);
    console.log(`[nostr] Connected to relay: ${relayUrl}`);
  }

  private async _publishDiscovery(): Promise<void> {
    const ev = {
      pubkey: this._pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: DISCOVERY_KIND,
      tags: [
        ["d", D_TAG_ID],
        ["t", "pulsar-server"],
      ],
      content: JSON.stringify({
        name: "Pulsar Server",
        version: "0.1.0",
        pubkey: this._pubkey,
        transport: "nostr",
      }),
    };

    const signed = await signEvent(ev, hexToBytes(this._seckey));

    for (const ws of this._wsConnections) {
      ws.send(JSON.stringify(["EVENT", signed]));
    }

    console.log(`[nostr] Published discovery event (kind=${DISCOVERY_KIND}, d=${D_TAG_ID})`);
  }

  private _subscribeSignaling(ws: WebSocket): void {
    const filter: NostrFilter = {
      kinds: [SIGNALING_KIND],
      "#p": [this._pubkey],
      limit: 0, // no history - ephemeral events
    };

    const subId = `pulsar-signal-${this._pubkey.slice(0, 8)}`;
    ws.send(JSON.stringify(["REQ", subId, filter]));

    ws.addEventListener("message", (event) => {
      if (this._shuttingDown) return;

      let msg: any[];
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg[0] === "EVENT" && msg[1] === subId) {
        const relayEvent = msg[2] as SignedNostrEvent;
        this._handleSignalingEvent(relayEvent, ws).catch((err) => {
          console.error(`[nostr] Error handling signaling event: ${err.message}`);
          this.onerror?.(err);
        });
      }
    });
  }

  private async _handleSignalingEvent(
    event: SignedNostrEvent,
    relayWs: WebSocket,
  ): Promise<void> {
    // Decrypt the payload
    let payload: SignalingPayload;
    try {
      const plaintext = await nip44Decrypt(event.content, this._seckey, event.pubkey);
      payload = JSON.parse(plaintext);
    } catch (err) {
      console.error(`[nostr] Failed to decrypt signaling from ${event.pubkey}: ${err}`);
      return;
    }

    const clientPubkey = event.pubkey;

    if (payload.type === "offer" && payload.sdp) {
      console.log(`[nostr] Received WebRTC offer from ${clientPubkey.slice(0, 8)}`);

      // Create a new RTCPeerConnection for this client
      const pc = new RTCPeerConnection({ iceServers: defaultIceServers });
      this._peerConnections.set(clientPubkey, pc);

      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          this._peerConnections.delete(clientPubkey);
          try { pc.close(); } catch { /* ignore */ }
        }
      });

      // Set remote description
      const remoteDesc = {
        type: "offer" as const,
        sdp: payload.sdp,
      };
      await pc.setRemoteDescription(remoteDesc);

      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering
      await this._waitForIceGathering(pc);

      const localDesc = pc.localDescription;
      if (!localDesc) throw new Error("Missing local description");

      // Encrypt and send answer back
      const answerPayload: SignalingPayload = {
        type: "answer",
        sdp: localDesc.sdp,
      };
      const encrypted = await nip44Encrypt(
        JSON.stringify(answerPayload),
        this._seckey,
        clientPubkey,
      );

      const replyEvent = await signEvent(
        {
          pubkey: this._pubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: SIGNALING_KIND,
          tags: [["p", clientPubkey]],
          content: encrypted,
        },
        hexToBytes(this._seckey),
      );

      relayWs.send(JSON.stringify(["EVENT", replyEvent]));
      console.log(`[nostr] Sent encrypted answer to ${clientPubkey.slice(0, 8)}`);

      // Wire the tunnel when data channels arrive
      pc.ondatachannel = (chEvent) => {
        const channel = chEvent.channel;

        if (channel.label === keepaliveLabel) {
          console.log(`[nostr] Keepalive channel open for ${clientPubkey.slice(0, 8)}`);

          // Wire the tunnel
          const conn = new NostrServerConnection(
            (pc as any)._dtlsTransport,
            (pc as any)._sctpTransport,
            channel,
            pc,
          );

          this.onconnection?.(conn);
          wireTunnel(conn);
        }
      };
    } else if (payload.type === "ice" && payload.candidate) {
      // Handle trickle ICE candidates
      const pc = this._peerConnections.get(clientPubkey);
      if (pc) {
        try {
          await pc.addIceCandidate({
            candidate: payload.candidate,
            sdpMid: payload.sdpMid ?? "0",
            sdpMLineIndex: payload.sdpMLineIndex ?? 0,
          });
        } catch (err) {
          console.error(`[nostr] Failed to add ICE candidate: ${err}`);
        }
      }
    }
  }

  private async _waitForIceGathering(
    pc: RTCPeerConnection,
    timeoutMs = 3000,
  ): Promise<void> {
    if (pc.iceGatheringState === "complete") return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), timeoutMs);

      const onStateChange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      };

      const onCandidate = (event: any) => {
        if (!event.candidate) {
          clearTimeout(timeout);
          resolve();
        }
      };

      pc.addEventListener("icegatheringstatechange", onStateChange);
      pc.addEventListener("icecandidate", onCandidate);
    });
  }

  close() {
    this._shuttingDown = true;
    for (const ws of this._wsConnections) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this._wsConnections.length = 0;
    for (const pc of this._peerConnections.values()) {
      try { pc.close(); } catch { /* ignore */ }
    }
    this._peerConnections.clear();
  }
}
