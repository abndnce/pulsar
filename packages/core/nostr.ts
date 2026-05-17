import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

export const NOSTR_RELAYS = [
  "wss://nostr.data.haus",
  "wss://kotukonostr.onrender.com",
] as const;

export const SIGNALING_KIND = 24393;
export const DISCOVERY_KIND = 34393;
export const D_TAG_ID = "pulsar-tunnel";
export const DISCOVERY_LIMIT = 20;
export const SIGNALING_SINCE_GRACE_SECONDS = 5;
export const SIGNAL_ENCRYPTION_VERSION = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export type UnsignedNostrEvent = Omit<NostrEvent, "id" | "sig">;

export interface SignedNostrEvent extends UnsignedNostrEvent {
  id: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  "#d"?: string[];
  "#p"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

export type NostrOutgoingMsg =
  | ["EVENT", SignedNostrEvent]
  | ["REQ", string, NostrFilter]
  | ["CLOSE", string];

export type NostrIncomingMsg =
  | ["EVENT", string, SignedNostrEvent]
  | ["EOSE", string]
  | ["NOTICE", string]
  | ["OK", string, boolean, string]
  | ["CLOSED", string, string];

export interface NostrKeypair {
  seckey: string;
  pubkey: string;
}

export interface SignalingPayload {
  type: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function tunnelCodeFromPubkey(pubkeyHex: string): string {
  return pubkeyHex.slice(0, 4);
}

export function nostrTunnelId(pubkeyHex: string): string {
  return `pulsar${tunnelCodeFromPubkey(pubkeyHex)}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function generateNostrKeypair(): NostrKeypair {
  const seckey = secp256k1.utils.randomPrivateKey();
  return {
    seckey: bytesToHex(seckey),
    pubkey: bytesToHex(schnorr.getPublicKey(seckey)),
  };
}

export function hasTag(
  event: NostrEvent,
  name: string,
  value: string,
): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

export function isAddressedTo(event: NostrEvent, pubkey: string): boolean {
  return hasTag(event, "p", pubkey);
}

export function serializeEvent(event: UnsignedNostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export async function computeEventId(
  event: UnsignedNostrEvent,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(serializeEvent(event)),
  );
  return bytesToHex(new Uint8Array(hash));
}

export async function signNostrEvent(
  event: UnsignedNostrEvent,
  seckeyHex: string,
): Promise<SignedNostrEvent> {
  const id = await computeEventId(event);
  const sig = schnorr.sign(hexToBytes(id), hexToBytes(seckeyHex));
  return { ...event, id, sig: bytesToHex(sig) };
}

export async function verifyNostrEvent(
  event: SignedNostrEvent,
): Promise<boolean> {
  try {
    if (event.id !== await computeEventId(event)) return false;
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return false;
  }
}

export function makeDiscoveryEvent(pubkey: string): UnsignedNostrEvent {
  return {
    pubkey,
    created_at: nowSeconds(),
    kind: DISCOVERY_KIND,
    tags: [["d", D_TAG_ID]],
    content: JSON.stringify({
      tunnel_code: tunnelCodeFromPubkey(pubkey),
    }),
  };
}

export function makeSignalEvent(
  pubkey: string,
  peerPubkey: string,
  content: string,
): UnsignedNostrEvent {
  return {
    pubkey,
    created_at: nowSeconds(),
    kind: SIGNALING_KIND,
    tags: [["p", peerPubkey]],
    content,
  };
}

export function makeSignalingFilter(pubkey: string): NostrFilter {
  return {
    kinds: [SIGNALING_KIND],
    "#p": [pubkey],
    since: nowSeconds() - SIGNALING_SINCE_GRACE_SECONDS,
  };
}

export function makeDiscoveryFilter(): NostrFilter {
  return {
    kinds: [DISCOVERY_KIND],
    "#d": [D_TAG_ID],
    limit: DISCOVERY_LIMIT,
  };
}

export function sendNostrEvent(ws: WebSocket, event: SignedNostrEvent): void {
  const msg: NostrOutgoingMsg = ["EVENT", event];
  ws.send(JSON.stringify(msg));
}

export function sendNostrReq(
  ws: WebSocket,
  subId: string,
  filter: NostrFilter,
): void {
  const msg: NostrOutgoingMsg = ["REQ", subId, filter];
  ws.send(JSON.stringify(msg));
}

export function closeNostrReq(ws: WebSocket, subId: string): void {
  const msg: NostrOutgoingMsg = ["CLOSE", subId];
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* best effort */
  }
}

export function parseNostrMessage(data: unknown): NostrIncomingMsg | null {
  if (typeof data !== "string") return null;

  try {
    const msg = JSON.parse(data);
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return null;
    return msg as NostrIncomingMsg;
  } catch {
    return null;
  }
}

export async function encryptSignal(
  plaintext: string,
  seckeyHex: string,
  pubkeyHex: string,
): Promise<string> {
  const key = await getSignalKey(hexToBytes(seckeyHex), hexToBytes(pubkeyHex));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    key,
    toArrayBuffer(textEncoder.encode(plaintext)),
  );

  const bytes = new Uint8Array(1 + nonce.byteLength + encrypted.byteLength);
  bytes[0] = SIGNAL_ENCRYPTION_VERSION;
  bytes.set(nonce, 1);
  bytes.set(new Uint8Array(encrypted), 1 + nonce.byteLength);
  return bytesToBase64(bytes);
}

export async function decryptSignal(
  ciphertextB64: string,
  seckeyHex: string,
  pubkeyHex: string,
): Promise<string> {
  const raw = base64ToBytes(ciphertextB64);
  if (raw.length < 13) throw new Error("Ciphertext too short");
  if (raw[0] !== SIGNAL_ENCRYPTION_VERSION) {
    throw new Error(`Unsupported signal encryption version ${raw[0]}`);
  }

  const key = await getSignalKey(hexToBytes(seckeyHex), hexToBytes(pubkeyHex));
  const nonce = raw.slice(1, 13);
  const ciphertext = raw.slice(13);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    key,
    toArrayBuffer(ciphertext),
  );
  return textDecoder.decode(decrypted);
}

function getSharedXOnly(
  seckey: Uint8Array,
  pubkeyXOnly: Uint8Array,
): Uint8Array {
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(pubkeyXOnly, 1);

  const pubPoint = secp256k1.ProjectivePoint.fromHex(compressed);
  const sharedPoint = pubPoint.multiply(bytesToBigInt(seckey));
  return new Uint8Array(sharedPoint.toRawBytes(false).slice(1, 33));
}

async function getSignalKey(
  seckeyBytes: Uint8Array,
  pubkeyBytes: Uint8Array,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(getSharedXOnly(seckeyBytes, pubkeyBytes)),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(0),
      info: toArrayBuffer(textEncoder.encode("pulsar-nostr-signal-v1")),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return BigInt(`0x${hex}`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
