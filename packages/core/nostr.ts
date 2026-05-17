// ── Nostr relay endpoints ──────────────────────────────────────────
// Client should try these in order; server should listen to both.

export const NOSTR_RELAYS = [
  "wss://nostr.data.haus",
  "wss://kotukonostr.onrender.com",
] as const;

// ── Nostr event kind constants ────────────────────────────────────

/** Ephemeral event kind used for encrypted WebRTC signaling. */
export const SIGNALING_KIND = 28000;

/** Parameterized replaceable event kind used for server discovery. */
export const DISCOVERY_KIND = 38000;

/** The `d` tag identifier for the Pulsar server discovery event. */
export const D_TAG_ID = "pulsar-server";

/** Derive a human-readable tunnel code from a server's 32-byte x-only pubkey. */
export function tunnelCodeFromPubkey(pubkeyHex: string): string {
  return "pulsar" + pubkeyHex.slice(0, 4);
}

// ── Nostr event types ─────────────────────────────────────────────

export interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export interface SignedNostrEvent extends NostrEvent {
  id: string;
  sig: string;
}

// ── Nostr subscription filter ─────────────────────────────────────

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

// ── Nostr WebSocket message types ─────────────────────────────────

export type NostrOutgoingMsg =
  | ["EVENT", SignedNostrEvent]
  | ["REQ", string, NostrFilter]
  | ["CLOSE", string];

export type NostrIncomingMsg =
  | ["EVENT", string, SignedNostrEvent]
  | ["EOSE", string]
  | ["NOTICE", string];
