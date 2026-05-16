/**
 * Nostr relay transport (placeholder).
 *
 * In the future, this will implement a Nostr-based signaling layer for
 * establishing peer connections through a Nostr relay.
 */
export class PulsarNostrServer {
  // TODO: implement Nostr relay signaling
  async accept(): Promise<never> {
    throw new Error("Nostr mode not yet implemented");
  }

  close() {
    // no-op
  }
}
