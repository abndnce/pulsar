import {
  NOSTR_RELAYS,
  SIGNALING_KIND,
  DISCOVERY_KIND,
  D_TAG_ID,
  type SignedNostrEvent,
} from "../../../core/nostr.ts";
import { KEEPALIVE_LABEL } from "../../../core/constants.ts";
import type { PulsarClientConnection } from "./types.ts";

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
  // Nostr uses 32-byte x-only public keys (BIP-340/Schnorr)
  const fullPub = secp256k1.getPublicKey(seckey, true);
  const pubkey = fullPub.slice(1); // strip 0x02/0x03 prefix → 32-byte x-only
  return {
    seckey: bytesToHex(seckey),
    pubkey: bytesToHex(pubkey),
  };
}

// ── NIP-44 encryption ────────────────────────────────────────────

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

async function getConversationKey(
  seckeyBytes: Uint8Array,
  pubkeyBytes: Uint8Array,
): Promise<CryptoKey> {
  const sharedSecret = getSharedXOnly(seckeyBytes, pubkeyBytes);

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

// ── Nostr WebSocket helpers ───────────────────────────────────────

function connectRelay(url: string, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection to ${url} timed out`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to connect to ${url}`));
    });
  });
}

/**
 * Try each relay in order until one connects successfully.
 */
async function connectToAnyRelay(): Promise<WebSocket> {
  const errors: string[] = [];
  for (const relayUrl of NOSTR_RELAYS) {
    try {
      const ws = await connectRelay(relayUrl);
      console.log(`[nostr] Connected to ${relayUrl}`);
      return ws;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.warn(`[nostr] ${relayUrl}: ${msg}`);
    }
  }
  throw new Error(
    `Failed to connect to any Nostr relay: ${errors.join("; ")}`,
  );
}

/**
 * Subscribe to events matching a filter and yield matching events.
 * Sends CLOSE when the generator is garbage collected or throws.
 */
function subscribeEvents(
  ws: WebSocket,
  subId: string,
  filter: Record<string, unknown>,
): AsyncGenerator<SignedNostrEvent> {
  const buffer: SignedNostrEvent[] = [];
  let resolve: ((value: IteratorResult<SignedNostrEvent>) => void) | null = null;
  let done = false;

  ws.send(JSON.stringify(["REQ", subId, filter]));

  const onMessage = (event: MessageEvent) => {
    let msg: any[];
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg[0] === "EVENT" && msg[1] === subId) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg[2] as SignedNostrEvent, done: false });
      } else {
        buffer.push(msg[2] as SignedNostrEvent);
      }
    }
  };

  ws.addEventListener("message", onMessage);

  const cleanup = () => {
    if (!done) {
      done = true;
      ws.removeEventListener("message", onMessage);
      ws.send(JSON.stringify(["CLOSE", subId]));
    }
  };

  const iterator: AsyncGenerator<SignedNostrEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<SignedNostrEvent>> {
      if (done) return { value: undefined, done: true };
      if (buffer.length > 0) {
        return { value: buffer.shift()!, done: false };
      }
      return await new Promise<IteratorResult<SignedNostrEvent>>((r) => {
        resolve = r;
      });
    },
    async return(): Promise<IteratorResult<SignedNostrEvent>> {
      cleanup();
      return { value: undefined, done: true };
    },
    async throw(err): Promise<IteratorResult<SignedNostrEvent>> {
      cleanup();
      throw err;
    },
  };

  return iterator;
}

/**
 * Wait for a single event matching a filter, with timeout.
 */
function waitForEvent(
  ws: WebSocket,
  subId: string,
  filter: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<SignedNostrEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.send(JSON.stringify(["CLOSE", subId]));
      reject(new Error("Timed out waiting for Nostr event"));
    }, timeoutMs);

    ws.send(JSON.stringify(["REQ", subId, filter]));

    const onMessage = (event: MessageEvent) => {
      let msg: any[];
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg[0] === "EVENT" && msg[1] === subId) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        ws.send(JSON.stringify(["CLOSE", subId]));
        resolve(msg[2] as SignedNostrEvent);
      }
    };

    ws.addEventListener("message", onMessage);
  });
}

// ── Default ICE servers ───────────────────────────────────────────

const defaultIceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

// ── Signaling payload type ────────────────────────────────────────

interface SignalingPayload {
  type: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

// ── Nostr client connection ───────────────────────────────────────

/**
 * Represents a Pulsar tunnel connection established via Nostr signaling.
 */
class NostrClientConnection implements PulsarClientConnection {
  constructor(
    public readonly keepalive: RTCDataChannel,
    public readonly pc: RTCPeerConnection,
    private _ws: WebSocket,
    private _seckey: string,
    private _serverPubkey: string,
  ) {}

  async close() {
    try { this.keepalive.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    try { this._ws.close(); } catch { /* ignore */ }
  }
}

// ── connectNostr ──────────────────────────────────────────────────

/**
 * Find a Pulsar server via discovery events.
 *
 * If `pubkeyPrefix` is given (4 hex chars), returns the first server
 * whose pubkey starts with that prefix. Otherwise returns any server.
 */
async function findServer(
  ws: WebSocket,
  pubkeyPrefix?: string,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.send(JSON.stringify(["CLOSE", "pulsar-discover"]));
      reject(
        new Error(
          pubkeyPrefix
            ? `No Pulsar server with tunnel code "pulsar${pubkeyPrefix}" found`
            : "No Pulsar server found on Nostr relay",
        ),
      );
    }, timeoutMs);

    const subId = "pulsar-discover";
    ws.send(
      JSON.stringify([
        "REQ",
        subId,
        { kinds: [DISCOVERY_KIND], "#d": [D_TAG_ID], limit: 0 },
      ]),
    );

    const onMessage = (event: MessageEvent) => {
      let msg: any[];
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg[0] === "EVENT" && msg[1] === subId) {
        const ev = msg[2] as SignedNostrEvent;
        if (pubkeyPrefix) {
          if (ev.pubkey.startsWith(pubkeyPrefix)) {
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            ws.send(JSON.stringify(["CLOSE", subId]));
            resolve(ev.pubkey);
          }
        } else {
          // Return the first discovery event
          clearTimeout(timeout);
          ws.removeEventListener("message", onMessage);
          ws.send(JSON.stringify(["CLOSE", subId]));
          resolve(ev.pubkey);
        }
      }
    };

    ws.addEventListener("message", onMessage);
  });
}

/**
 * Establish a Pulsar tunnel via Nostr relay signaling.
 *
 * 1. Connects to a Nostr relay (tries nostr.data.haus first,
 *    then kotukonostr.onrender.com)
 * 2. Looks up the server's discovery event (Kind 38000, d="pulsar-server").
 *    If `tunnelCode` is given (e.g. "pulsara3f2"), filters to the server
 *    whose pubkey begins with the 4-char suffix after "pulsar".
 * 3. Generates an ephemeral client keypair
 * 4. Creates a WebRTC offer
 * 5. Encrypts the offer and sends via a Kind 28000 ephemeral event
 * 6. Waits for the encrypted answer
 * 7. Sets the answer as remote description
 * 8. Returns the connected PulsarClientConnection
 */
export async function connectNostr(tunnelCode?: string): Promise<PulsarClientConnection> {
  // 1. Connect to a relay
  const ws = await connectToAnyRelay();

  // 2. Look up the server
  const pubkeyPrefix = tunnelCode
    ? tunnelCode.replace(/^pulsar/, "").slice(0, 4)
    : undefined;

  console.log(
    "[nostr] Looking up Pulsar server" +
      (pubkeyPrefix ? ` (tunnel ${tunnelCode})` : "") +
      "...",
  );

  const serverPubkey = await findServer(ws, pubkeyPrefix);
  console.log(`[nostr] Found server: ${serverPubkey.slice(0, 16)}...`);

  // 3. Generate client keypair
  const clientKeys = generateKeypair();
  console.log(`[nostr] Client pubkey: ${clientKeys.pubkey.slice(0, 16)}...`);

  // 4. Create WebRTC offer
  const pc = new RTCPeerConnection({ iceServers: defaultIceServers });
  const keepalive = pc.createDataChannel(KEEPALIVE_LABEL, { ordered: true });
  keepalive.binaryType = "arraybuffer";

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 2000);

    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        resolve();
      }
    };

    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) {
        clearTimeout(timeout);
        resolve();
      }
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
  });

  const localDesc = pc.localDescription;
  if (!localDesc) throw new Error("Failed to create local offer");

  // 5. Encrypt and send offer
  const offerPayload: SignalingPayload = {
    type: "offer",
    sdp: localDesc.sdp,
  };

  const encryptedOffer = await nip44Encrypt(
    JSON.stringify(offerPayload),
    clientKeys.seckey,
    serverPubkey,
  );

  const offerEvent = await signEvent(
    {
      pubkey: clientKeys.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: SIGNALING_KIND,
      tags: [["p", serverPubkey]],
      content: encryptedOffer,
    },
    hexToBytes(clientKeys.seckey),
  );

  // Subscribe for answer BEFORE sending the offer (don't miss it)
  const answerPromise = waitForEvent(
    ws,
    "pulsar-answer",
    {
      kinds: [SIGNALING_KIND],
      "#p": [clientKeys.pubkey],
      limit: 1,
    },
    30_000,
  );

  // Send the offer
  ws.send(JSON.stringify(["EVENT", offerEvent]));
  console.log("[nostr] Sent encrypted offer, waiting for answer...");

  // 6. Wait for answer
  const answerEvent = await answerPromise;
  const answerPlaintext = await nip44Decrypt(
    answerEvent.content,
    clientKeys.seckey,
    serverPubkey,
  );

  const answerPayload: SignalingPayload = JSON.parse(answerPlaintext);
  if (answerPayload.type !== "answer" || !answerPayload.sdp) {
    throw new Error("Invalid answer from server");
  }

  console.log("[nostr] Received answer, connecting WebRTC...");

  // 7. Set remote description
  await pc.setRemoteDescription({
    type: "answer",
    sdp: answerPayload.sdp,
  });

  // 8. Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebRTC connection timed out after 30s"));
    }, 30_000);

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        clearTimeout(timeout);
        resolve();
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        clearTimeout(timeout);
        reject(new Error(`Connection failed: ${pc.connectionState}`));
      }
    });
  });

  console.log("[nostr] WebRTC connected!");

  return new NostrClientConnection(
    keepalive,
    pc,
    ws,
    clientKeys.seckey,
    serverPubkey,
  );
}
