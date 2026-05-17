import { SOCKET_PREFIX } from "../../core/constants.ts";

// ── WebSocket-like adapter for libcurl.js ──────────────────────────

/**
 * A minimal WebSocket-like wrapper around an RTCDataChannel.
 *
 * libcurl.js expects its transport factory to return objects
 * with `send()`, `close()`, `onopen`, `onmessage`, `onclose`,
 * and `onerror` — which is exactly the RTCDataChannel API, so
 * the wrapper is thin.
 */
class DataChannelSocket {
  private _channel: RTCDataChannel;
  private _closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;

  constructor(channel: RTCDataChannel) {
    this._channel = channel;

    channel.onopen = () => {
      if (!this._closed) this.onopen?.();
    };

    channel.onmessage = (event) => {
      if (!this._closed) this.onmessage?.({ data: event.data as ArrayBuffer | string });
    };

    channel.onclose = () => {
      this._closed = true;
      this.onclose?.();
    };

    channel.onerror = (event) => {
      this.onerror?.({ error: String(event) });
    };
  }

  get readyState(): string {
    return this._channel.readyState;
  }

  get binaryType(): string {
    return "arraybuffer";
  }

  set binaryType(_: string) {
    // RTCDataChannel.binaryType is already "arraybuffer" by default in browsers
  }

  send(data: ArrayBuffer | string | ArrayBufferView): void {
    if (this._closed || this._channel.readyState !== "open") return;
    (this._channel as any).send(data);
  }

  close(): void {
    this._closed = true;
    try {
      this._channel.close();
    } catch {
      /* ignore */
    }
  }
}

// ── libcurlTransport ──────────────────────────────────────────────

/**
 * Create a libcurl.js transport factory from an existing WebRTC
 * peer connection.
 *
 * Usage:
 * ```ts
 * import { connectDirect, libcurlTransport } from '@abndnce/pulsar-client';
 * import { libcurl } from 'libcurl.js';
 *
 * const tunnel = await connectDirect('216.250.119.217', 42069);
 * libcurl.transport = libcurlTransport(tunnel.pc);
 * libcurl.set_websocket('wss://pulsar-tunnel.local/');
 * ```
 *
 * libcurl.js calls the factory with URLs like:
 *   `wss://pulsar-tunnel.local/example.com:80`
 *   `wss://pulsar-tunnel.local/216.250.119.217:443`
 *
 * The factory parses `<hostname>:<port>` from the URL path, opens a
 * Pulsar socket data channel, and returns a WebSocket-like adapter.
 */
export function libcurlTransport(
  pc: RTCPeerConnection,
): (url: string) => DataChannelSocket {
  return (url: string): DataChannelSocket => {
    // Parse destination from URL path: "wss://host/path" → "path"
    let dest: string;
    try {
      const parsed = new URL(url);
      dest = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
    } catch {
      // Fallback: manual parse
      const slash = url.indexOf("/", url.indexOf("//") + 2);
      dest = slash === -1 ? url : url.slice(slash + 1);
    }

    if (!dest) {
      throw new Error(`libcurl transport: no destination found in URL "${url}"`);
    }

    // Validate the destination format (hostname:port)
    const sep = dest.lastIndexOf(":");
    if (sep === -1) {
      throw new Error(`libcurl transport: invalid destination "${dest}" — expected "hostname:port"`);
    }

    // Open a data channel asynchronously, but return immediately.
    // libcurl.js can handle the channel opening after the factory returns.
    const channel = pc.createDataChannel(`${SOCKET_PREFIX}${dest}`, {
      ordered: true,
    });

    return new DataChannelSocket(channel);
  };
}


