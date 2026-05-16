import type { PulsarClientConnection } from "./types.ts";

/**
 * Connect via a Nostr relay (placeholder).
 *
 * In the future, this will implement a Nostr-based signaling layer for
 * establishing peer connections through a Nostr relay.
 */
export async function connectNostr(
  _relay: string,
  _pubkey: string,
): Promise<PulsarClientConnection> {
  throw new Error("Nostr mode not yet implemented");
}
