/**
 * Browser-based Nostr relay for Pulsar.
 *
 * This relay connects to upstream Nostr relays and multiplexes events
 * from local clients. It can also serve as a standalone relay endpoint
 * via BroadcastChannel for multi-tab coordination.
 */

import { secp256k1 } from "@noble/curves/secp256k1";

// ── Types ─────────────────────────────────────────────────────────

interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

interface SignedNostrEvent extends NostrEvent {
  id: string;
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

type Subscription = {
  id: string;
  filter: NostrFilter;
  sendEvent: (event: SignedNostrEvent) => void;
  sendEose: () => void;
};

// ── Event storage ─────────────────────────────────────────────────

class EventStore {
  private events: SignedNostrEvent[] = [];
  private byKind = new Map<number, SignedNostrEvent[]>();
  private byPubkey = new Map<string, SignedNostrEvent[]>();

  add(event: SignedNostrEvent): boolean {
    // Replaceable events: NIP-33 (kinds 30000-39999) — replace by (kind, pubkey, d-tag)
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      const existingIdx = this.events.findIndex(
        (e) =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          (e.tags.find((t) => t[0] === "d")?.[1] ?? "") === dTag,
      );
      if (existingIdx !== -1) {
        if (event.created_at <= this.events[existingIdx]!.created_at) {
          return false; // not newer
        }
        this.events[existingIdx] = event;
        return true;
      }
    }

    // Regular events: check for duplicate by ID
    if (this.events.some((e) => e.id === event.id)) {
      return false;
    }

    this.events.push(event);
    this._index(event);
    return true;
  }

  private _index(event: SignedNostrEvent) {
    let byKind = this.byKind.get(event.kind);
    if (!byKind) {
      byKind = [];
      this.byKind.set(event.kind, byKind);
    }
    byKind.push(event);

    let byPubkey = this.byPubkey.get(event.pubkey);
    if (!byPubkey) {
      byPubkey = [];
      this.byPubkey.set(event.pubkey, byPubkey);
    }
    byPubkey.push(event);
  }

  query(filter: NostrFilter): SignedNostrEvent[] {
    let results = this.events;

    if (filter.ids) {
      results = results.filter((e) => filter.ids!.includes(e.id));
    }
    if (filter.authors) {
      results = results.filter((e) => filter.authors!.includes(e.pubkey));
    }
    if (filter.kinds) {
      results = results.filter((e) => filter.kinds!.includes(e.kind));
    }
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
    if (filter.since) {
      results = results.filter((e) => e.created_at >= filter.since!);
    }
    if (filter.until) {
      results = results.filter((e) => e.created_at <= filter.until!);
    }

    // Sort by created_at descending (newest first)
    results = [...results].sort((a, b) => b.created_at - a.created_at);

    if (filter.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  get size(): number {
    return this.events.length;
  }
}

// ── Relay class ───────────────────────────────────────────────────

type RelayStatus =
  | { type: "idle" }
  | { type: "connecting"; relay: string }
  | { type: "connected"; relay: string }
  | { type: "failed"; relay: string; error: string };

type UpdateCallback = (update: {
  status: RelayStatus[];
  eventCount: number;
  subCount: number;
}) => void;

const DEFAULT_UPSTREAM_RELAYS = [
  "wss://nostr.data.haus",
  "wss://kotukonostr.onrender.com",
];

export class PulsarRelay {
  private upstreamConns: { ws: WebSocket; url: string }[] = [];
  private store = new EventStore();
  private subs = new Map<string, Subscription>();
  private localSubId = 0;
  private _statuses: RelayStatus[] = [{ type: "idle" }];
  private onUpdate: UpdateCallback = () => {};

  get statuses(): RelayStatus[] {
    return this._statuses;
  }

  setUpdateCallback(cb: UpdateCallback) {
    this.onUpdate = cb;
  }

  private notify() {
    this.onUpdate({
      status: this._statuses,
      eventCount: this.store.size,
      subCount: this.subs.size,
    });
  }

  /**
   * Connect to upstream Nostr relays.
   */
  async connect(relayUrls: string[] = [...DEFAULT_UPSTREAM_RELAYS]): Promise<void> {
    this._statuses = relayUrls.map((url) => ({ type: "connecting", relay: url } as const));
    this.notify();

    const promises = relayUrls.map((url) => this._connectUpstream(url));
    await Promise.allSettled(promises);

    // Subscribe to all events from upstream
    for (const conn of this.upstreamConns) {
      this._subscribeAll(conn);
    }

    this.notify();
  }

  private async _connectUpstream(url: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);

        ws.addEventListener("open", () => {
          console.log(`[relay] Connected to upstream ${url}`);
          this.upstreamConns.push({ ws, url });
          this._updateStatus(url, { type: "connected", relay: url });
          resolve();
        });

        ws.addEventListener("error", () => {
          this._updateStatus(url, {
            type: "failed",
            relay: url,
            error: "Connection error",
          });
          resolve(); // Don't reject — try other relays
        });

        ws.addEventListener("close", () => {
          const idx = this.upstreamConns.findIndex((c) => c.url === url);
          if (idx !== -1) this.upstreamConns.splice(idx, 1);
          this._updateStatus(url, {
            type: "failed",
            relay: url,
            error: "Connection closed",
          });
        });

        ws.addEventListener("message", (event) => {
          this._handleUpstreamMessage(url, event.data);
        });
      } catch (err) {
        this._updateStatus(url, {
          type: "failed",
          relay: url,
          error: err instanceof Error ? err.message : String(err),
        });
        resolve();
      }
    });
  }

  private _updateStatus(relay: string, status: RelayStatus) {
    const idx = this._statuses.findIndex((s) => s.type !== "idle" && (s as any).relay === relay);
    if (idx !== -1) {
      this._statuses[idx] = status;
    } else {
      this._statuses.push(status);
    }
    this.notify();
  }

  private _subscribeAll(conn: { ws: WebSocket; url: string }) {
    const subId = `pulsar-relay-all-${conn.url.replace(/[^a-z0-9]/g, "")}`;
    conn.ws.send(JSON.stringify(["REQ", subId, { kinds: [], limit: 0 }]));
  }

  private _handleUpstreamMessage(url: string, data: string) {
    let msg: any[];
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg[0] === "EVENT") {
      const event = msg[2] as SignedNostrEvent;
      if (!event.id || !event.sig) return;

      const isNew = this.store.add(event);
      if (isNew) {
        // Forward to local subscribers
        for (const sub of this.subs.values()) {
          if (this._matchesFilter(event, sub.filter)) {
            sub.sendEvent(event);
          }
        }
        this.notify();
      }
    }
  }

  private _matchesFilter(event: SignedNostrEvent, filter: NostrFilter): boolean {
    if (filter.ids && !filter.ids.includes(event.id)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter["#d"]) {
      const dTags = event.tags.filter((t) => t[0] === "d").map((t) => t[1]);
      if (!filter["#d"].some((d) => dTags.includes(d))) return false;
    }
    if (filter["#p"]) {
      const pTags = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      if (!filter["#p"].some((p) => pTags.includes(p))) return false;
    }
    if (filter.since && event.created_at < filter.since) return false;
    if (filter.until && event.created_at > filter.until) return false;
    return true;
  }

  /**
   * Create a subscription for a local client.
   * Returns the subscription ID.
   */
  subscribe(
    filter: NostrFilter,
    sendEvent: (event: SignedNostrEvent) => void,
    sendEose: () => void,
  ): string {
    const subId = `local-${++this.localSubId}`;
    this.subs.set(subId, { id: subId, filter, sendEvent, sendEose });

    // Send matching stored events first
    const matching = this.store.query(filter);
    for (const event of matching) {
      sendEvent(event);
    }
    sendEose();

    this.notify();
    return subId;
  }

  /**
   * Remove a subscription.
   */
  unsubscribe(subId: string) {
    this.subs.delete(subId);
    this.notify();
  }

  /**
   * Publish an event to the relay.
   * Stores it and forwards to upstream relays.
   */
  publish(event: SignedNostrEvent): boolean {
    if (!event.id || !event.sig) return false;

    const isNew = this.store.add(event);
    if (isNew) {
      // Forward to subscribers
      for (const sub of this.subs.values()) {
        if (this._matchesFilter(event, sub.filter)) {
          sub.sendEvent(event);
        }
      }
      // Forward to upstream relays
      for (const conn of this.upstreamConns) {
        conn.ws.send(JSON.stringify(["EVENT", event]));
      }
      this.notify();
    }
    return isNew;
  }

  /**
   * Disconnect from all upstream relays and clear state.
   */
  disconnect() {
    for (const conn of this.upstreamConns) {
      try { conn.ws.close(); } catch { /* ignore */ }
    }
    this.upstreamConns.length = 0;
    this.subs.clear();
    this._statuses = [{ type: "idle" }];
    this.notify();
  }
}
