import { RTCDataChannel, RTCSctpTransport, RTCDtlsTransport } from "npm:werift";
import { Buffer } from "node:buffer";
import { SOCKET_PREFIX, KEEPALIVE_LABEL } from "../../core/constants.ts";

// ── parseDestination ──────────────────────────────────────────────

/**
 * Parse a data channel label into a TCP destination.
 *
 * Label format: `socket/<hostname>:<port>`
 *
 * Supports IPv4, IPv6 (`[::1]:port`), and hostname destinations.
 */
function parseDestination(label: string): { hostname: string; port: number } {
  if (!label.startsWith(SOCKET_PREFIX)) {
    throw new Error(
      `Unknown channel label "${label}" — expected prefix "${SOCKET_PREFIX}"`,
    );
  }
  const dest = label.slice(SOCKET_PREFIX.length);
  if (!dest) throw new Error(`Socket destination missing from "${label}"`);

  // IPv6: [::1]:8080
  if (dest.startsWith("[")) {
    const cb = dest.indexOf("]");
    if (cb === -1 || dest[cb + 1] !== ":") {
      throw new Error(`Invalid IPv6 destination "${dest}"`);
    }
    const hostname = dest.slice(1, cb);
    const port = Number(dest.slice(cb + 2));
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid IPv6 destination "${dest}"`);
    }
    return { hostname, port };
  }

  // IPv4 / hostname: hostname:port
  const sep = dest.lastIndexOf(":");
  if (sep === -1) throw new Error(`Invalid destination "${dest}" — missing port`);
  const hostname = dest.slice(0, sep);
  const port = Number(dest.slice(sep + 1));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid destination "${dest}"`);
  }
  return { hostname, port };
}

// ── writeAll ──────────────────────────────────────────────────────

/** Write every byte of `data` to `conn`, retrying on partial writes. */
async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    offset += await conn.write(data.subarray(offset));
  }
}

// ── handleSocketChannel ───────────────────────────────────────────

/**
 * Bridge a single data channel to a raw TCP socket.
 *
 * Flow:
 *   channel onopen → Deno.connect(hostname, port) →
 *   channel.onmessage → tcp.write (serialised) +
 *   tcp.read → channel.send
 *
 * If the data channel opens before the TCP connection completes, data
 * is buffered in `pendingWrites` and flushed once connected.
 *
 * Errors on either side close both the channel and the socket.
 */
function handleSocketChannel(
  channel: RTCDataChannel,
  trackSocket?: (socket: Deno.Conn) => void,
  onError?: (err: Error) => void,
): void {
  const { hostname, port } = parseDestination(channel.label);
  let socket: Deno.Conn | undefined;
  let closed = false;
  const pendingWrites: Uint8Array[] = [];
  let writeChain = Promise.resolve();

  const logDebug = (msg: string) =>
    console.log(`[Tunnel] ${hostname}:${port} — ${msg}`);
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const closeSocket = () => {
    if (closed) return;
    closed = true;
    logDebug("Closing TCP socket");
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  };

  const closeChannel = () => {
    if (channel.readyState === "open" || channel.readyState === "connecting") {
      logDebug("Closing data channel");
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    }
  };

  /** Queue a chunk for writing, or write immediately if TCP is connected. */
  const queueWrite = (chunk: Uint8Array) => {
    if (!socket) {
      logDebug(
        `Buffering ${chunk.byteLength} bytes (TCP not yet connected)`,
      );
      pendingWrites.push(chunk);
      return;
    }
    logDebug(`Writing ${chunk.byteLength} bytes to TCP socket`);
    writeChain = writeChain
      .then(async () => {
        if (!closed && socket) await writeAll(socket, chunk);
      })
      .catch((e) => {
        const msg = `[Tunnel] Write failed for ${hostname}:${port}: ${errMsg(e)}`;
        console.error(msg);
        onError?.(new Error(msg));
        closeSocket();
        closeChannel();
      });
  };

  // ── Data channel events ──

  channel.onmessage = (event) => {
    logDebug("Received message from data channel");
    try {
      const data = event.data;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data as ArrayBuffer);
      queueWrite(bytes);
    } catch (e) {
      const msg = `[Tunnel] Invalid payload for ${hostname}:${port}: ${errMsg(e)}`;
      console.error(msg);
      onError?.(new Error(msg));
      closeSocket();
      closeChannel();
    }
  };

  channel.onclose = () => {
    logDebug("Data channel closed by remote peer");
    closeSocket();
  };
  channel.onerror = () => {
    logDebug("Data channel error from remote peer");
    closeSocket();
  };

  // ── TCP connection ──

  logDebug("Initiating TCP connection");
  void (async () => {
    try {
      socket = await Deno.connect({ hostname, port, transport: "tcp" });
      trackSocket?.(socket);
      logDebug("TCP socket connected");

      // Flush any data queued while TCP was connecting
      const flushed = pendingWrites.length;
      for (const chunk of pendingWrites.splice(0)) queueWrite(chunk);
      if (flushed > 0) logDebug(`Flushed ${flushed} buffered writes`);

      // Read loop: TCP → data channel
      const buf = new Uint8Array(16 * 1024);
      while (!closed) {
        const read = await socket.read(buf);
        if (read === null) {
          logDebug("TCP socket closed by remote end");
          break;
        }
        if (read > 0 && channel.readyState === "open") {
          logDebug(`Sending ${read} bytes to data channel`);
          channel.send(Buffer.from(buf.subarray(0, read)));
        }
      }
    } catch (e) {
      if (!closed) {
        const msg = `[Tunnel] Connection to ${hostname}:${port} failed: ${errMsg(e)}`;
        console.error(msg);
        onError?.(new Error(msg));
      }
    } finally {
      closeSocket();
      closeChannel();
    }
  })();
}

// ── handleDataChannel ─────────────────────────────────────────────

/**
 * Dispatch an incoming data channel.
 *
 * - `keepalive` → ignored (already handled by the connection setup)
 * - `socket/...` → bridged to TCP via handleSocketChannel
 * - anything else → closed with a warning
 */
function handleDataChannel(
  channel: RTCDataChannel,
  trackSocket?: (socket: Deno.Conn) => void,
  onError?: (err: Error) => void,
): void {
  // Ensure binary type for ArrayBuffer messages from the browser
  if ("binaryType" in channel) (channel as any).binaryType = "arraybuffer";

  console.log(
    `[Tunnel] Incoming data channel: label="${channel.label}", id=${channel.id}, state=${channel.readyState}`,
  );

  if (channel.label === KEEPALIVE_LABEL) {
    console.log("[Tunnel] Ignoring duplicate keepalive channel");
    return;
  }

  try {
    handleSocketChannel(channel, trackSocket, onError);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Tunnel] Failed to handle channel "${channel.label}": ${msg}`);
    channel.close();
  }
}

// ── wireTunnel ────────────────────────────────────────────────────

/**
 * Tunnel wiring options.
 * Any object with these properties qualifies (e.g. PulsarDirectConnection).
 */
export interface TunnelWireTarget {
  sctpTransport: RTCSctpTransport;
  dtlsTransport: RTCDtlsTransport;
  close(): Promise<void>;
  trackSocket(socket: Deno.Conn): void;
}

/**
 * Wire up the data channel → TCP tunnel bridge on an established
 * WebRTC connection.
 *
 * Subscribes to incoming data channels on the SCTP transport and
 * bridges them to raw TCP sockets. Also auto-closes the connection
 * when DTLS fails.
 *
 * Call this in your `onconnection` handler:
 * ```ts
 * server.onconnection = (conn) => {
 *   wireTunnel(conn);
 * };
 * ```
 */
export function wireTunnel(target: TunnelWireTarget): void {
  const { sctpTransport, dtlsTransport } = target;

  console.log("[Tunnel] Wiring tunnel bridge for new connection");

  // ── Wire incoming data channels → TCP bridge ──

  const sctp: any = sctpTransport;
  const dataChannelEvent = sctp.dataChannel as
    | { subscribe?: (fn: (ch: RTCDataChannel) => void) => void; on?: (fn: (ch: RTCDataChannel) => void) => void }
    | undefined;

  if (dataChannelEvent) {
    console.log("[Tunnel] Subscribing to incoming data channels");
    const handler = (channel: RTCDataChannel) => {
      console.log(
        `[Tunnel] Data channel received: label="${channel.label}", id=${channel.id}`,
      );
      handleDataChannel(channel, (s) => target.trackSocket(s), (err) => {
        console.error(`[Tunnel] Channel error: ${err.message}`);
      });
    };

    if (typeof dataChannelEvent.subscribe === "function") {
      dataChannelEvent.subscribe(handler);
    } else if (typeof dataChannelEvent.on === "function") {
      dataChannelEvent.on(handler);
    } else {
      console.log("[Tunnel] Falling back to ondatachannel property");
      (sctp as any).ondatachannel = (event: { channel: RTCDataChannel }) => {
        console.log(
          `[Tunnel] Data channel via ondatachannel: label="${event.channel.label}", id=${event.channel.id}`,
        );
        handleDataChannel(event.channel, (s) => target.trackSocket(s));
      };
    }
  } else {
    console.warn("[Tunnel] No dataChannel event source available on SCTP transport");
  }

  // ── Auto-cleanup on DTLS disconnect ──

  dtlsTransport.onStateChange?.subscribe?.((state: string) => {
    console.log(`[Tunnel] DTLS state changed: ${state}`);
    if (["failed", "closed"].includes(state)) {
      console.log("[Tunnel] DTLS disconnected, cleaning up tunnel");
      target.close().catch(() => {});
    }
  });
}

export { parseDestination, handleSocketChannel, handleDataChannel };
