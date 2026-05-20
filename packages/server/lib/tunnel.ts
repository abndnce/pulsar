import { RTCDataChannel, RTCDtlsTransport, RTCSctpTransport } from 'npm:werift';
import { Buffer } from 'node:buffer';
import { KEEPALIVE_LABEL } from '../../core/constants.ts';
import { parseSocketDestination } from '../../core/socket.ts';

// ── writeAll ──────────────────────────────────────────────────────

/** Write every byte of `data` to `conn`, retrying on partial writes. */
async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    offset += await conn.write(data.subarray(offset));
  }
}

// ── handleSocketChannel ───────────────────────────────────────────

// ── TLS detection ──────────────────────────────────────────────────

/** TLS Handshake content type as defined by RFC 8446 / RFC 5246. */
const TLS_HANDSHAKE_CT = 0x16;
const TLS_MAJOR_VERSION = 0x03;
const HTTPS_PORT = 443;

/**
 * Bridge a single data channel to a raw TCP socket.
 *
 * Flow:
 *   first TLS-like channel message → Deno.connect(hostname, port) →
 *   tcp.write (serialised) +
 *   tcp.read → channel.send
 *
 * If the data channel opens before the TCP connection completes, data
 * is buffered in `pendingWrites` and flushed once connected.
 *
 * **Non-HTTPS traffic is always rejected.** Destinations must use port 443,
 * and the first client message must look like a TLS handshake record.
 *
 * Errors on either side close both the channel and the socket.
 */
function handleSocketChannel(
  channel: RTCDataChannel,
  trackSocket?: (socket: Deno.Conn) => void,
  onError?: (err: Error) => void,
): void {
  const { hostname, port } = parseSocketDestination(channel.label);
  let socket: Deno.Conn | undefined;
  let closed = false;
  let receivedFirstMessage = false;
  let tcpStarted = false;
  const pendingWrites: Uint8Array[] = [];
  let writeChain = Promise.resolve();

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const closeSocket = () => {
    if (closed) return;
    closed = true;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  };

  const closeChannel = () => {
    if (channel.readyState === 'open' || channel.readyState === 'connecting') {
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
      pendingWrites.push(chunk);
      return;
    }
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

  /** Reject a connection with a log message and tear everything down. */
  const reject = (reason: string) => {
    const msg = `[Tunnel] Rejected ${hostname}:${port} — ${reason}`;
    console.warn(msg);
    onError?.(new Error(msg));
    closeSocket();
    closeChannel();
  };

  const startTcp = () => {
    if (tcpStarted || closed) return;
    tcpStarted = true;

    void (async () => {
      try {
        socket = await Deno.connect({ hostname, port, transport: 'tcp' });
        trackSocket?.(socket);

        // Flush any data queued while TCP was connecting
        for (const chunk of pendingWrites.splice(0)) queueWrite(chunk);

        // Read loop: TCP → data channel
        const buf = new Uint8Array(16 * 1024);
        while (!closed) {
          const read = await socket.read(buf);
          if (read === null) break;
          if (read > 0 && channel.readyState === 'open') {
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
  };

  if (port !== HTTPS_PORT) {
    reject('only HTTPS port 443 is allowed');
    return;
  }

  // ── Data channel events ──

  channel.onmessage = (event) => {
    try {
      const data = event.data;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : typeof data === 'string'
              ? new TextEncoder().encode(data)
              : new Uint8Array(data as ArrayBuffer);

      // ── Enforce TLS on the very first client message ──
      if (!receivedFirstMessage) {
        receivedFirstMessage = true;
        if (bytes.length < 5 || bytes[0] !== TLS_HANDSHAKE_CT || bytes[1] !== TLS_MAJOR_VERSION) {
          reject('first message is not a TLS handshake record');
          return;
        }
        startTcp();
      }

      queueWrite(bytes);
    } catch (e) {
      const msg = `[Tunnel] Invalid payload for ${hostname}:${port}: ${errMsg(e)}`;
      console.error(msg);
      onError?.(new Error(msg));
      closeSocket();
      closeChannel();
    }
  };

  channel.onclose = () => closeSocket();
  channel.onerror = () => closeSocket();

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
  if ('binaryType' in channel) (channel as any).binaryType = 'arraybuffer';

  if (channel.label === KEEPALIVE_LABEL) {
    console.log('[Tunnel] Ignoring duplicate keepalive channel');
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

  // ── Wire incoming data channels → TCP bridge ──

  const onDataChannel = sctpTransport.onDataChannel;

  if (onDataChannel && typeof onDataChannel.subscribe === 'function') {
    onDataChannel.subscribe((channel) =>
      handleDataChannel(
        channel,
        (s) => target.trackSocket(s),
        (err) => {
          console.error(`[Tunnel] Channel error: ${err.message}`);
        },
      ),
    );
  }

  // ── Auto-cleanup on DTLS disconnect ──

  dtlsTransport.onStateChange?.subscribe?.((state: string) => {
    if (['failed', 'closed'].includes(state)) {
      target.close().catch(() => {});
    }
  });
}
