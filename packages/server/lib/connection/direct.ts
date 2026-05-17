import {
  classes,
  Message,
  methods,
  parseMessage,
  RTCCertificate,
  RTCDataChannel,
  RTCDataChannelParameters,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCDtlsTransport,
  RTCSctpTransport,
} from 'npm:werift';
import { Event } from 'npm:werift';
import { Buffer } from 'node:buffer';
import {
  KEEPALIVE_LABEL,
  PULSAR_CERT_PEM,
  PULSAR_FINGERPRINT,
  PULSAR_KEY_PEM,
  PULSAR_PWD,
  PULSAR_SIGNATURE_HASH,
} from '../../../core/constants.ts';
import type { PulsarServerConnection } from './types.ts';

// ── STUN ─────────────────────────────────────────────────────────

/** Convert a Uint8Array to a Buffer (required by werift's STUN parser). */
function toBuffer(data: Uint8Array): Buffer {
  return data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function isStunBindingRequest(data: Uint8Array): boolean {
  if (data.length < 20) return false;
  const buf = toBuffer(data);
  const msg = parseMessage(buf);
  return (
    msg !== undefined &&
    msg.messageMethod === methods.BINDING &&
    msg.messageClass === classes.REQUEST
  );
}

function buildStunResponse(data: Uint8Array, addr: Deno.NetAddr): Uint8Array | null {
  const buf = toBuffer(data);
  const msg = parseMessage(buf);
  if (!msg) return null;
  try {
    const res = new Message(methods.BINDING, classes.RESPONSE, msg.transactionId);
    res.setAttribute('XOR-MAPPED-ADDRESS', [addr.hostname, addr.port]);
    res.addMessageIntegrity(PULSAR_PWD as any);
    res.addFingerprint();
    return res.bytes;
  } catch {
    return null;
  }
}

// ── PeerTransport ────────────────────────────────────────────────

class PeerTransport {
  closed = false;
  readonly onData = new Event<[Uint8Array]>();
  readonly address = {};
  readonly type = 'ice';
  private _rawSocket: Deno.DatagramConn;
  private _peerAddr: Deno.NetAddr;

  constructor(rawSocket: Deno.DatagramConn, peerAddr: Deno.NetAddr) {
    this._rawSocket = rawSocket;
    this._peerAddr = peerAddr;
  }

  feed(buf: Uint8Array) {
    if (this.closed) return;
    if (buf[0] > 19 && buf[0] < 64) {
      // werift's DTLS/ICE handlers expect Buffer with Node.js methods
      this.onData.execute(
        buf instanceof Buffer ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
      );
    }
  }

  send = (data: Uint8Array) => {
    if (this.closed) return;
    this._rawSocket.send(data, this._peerAddr).catch(() => {});
  };

  close() {
    this.closed = true;
  }
}

// ── PulsarDirectConnection ───────────────────────────────────────

export class PulsarDirectConnection implements PulsarServerConnection {
  /** Set of all active TCP sockets created for tunnel channels. */
  readonly tcpSockets = new Set<Deno.Conn>();

  constructor(
    public readonly dtlsTransport: RTCDtlsTransport,
    public readonly sctpTransport: RTCSctpTransport,
    public readonly keepalive: RTCDataChannel,
    private _transport: PeerTransport,
  ) {}

  /** Register a TCP socket for lifecycle cleanup. */
  trackSocket(socket: Deno.Conn): void {
    this.tcpSockets.add(socket);
  }

  async close() {
    // Close all tunnel TCP sockets
    for (const sock of this.tcpSockets) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
    this.tcpSockets.clear();

    try {
      this.keepalive.close();
    } catch {}
    try {
      await this.sctpTransport.stop();
    } catch {}
    try {
      await this.dtlsTransport.stop();
    } catch {}
    this._transport.close();
  }
}

// ── Session builder ──────────────────────────────────────────────

async function startSession(transport: PeerTransport): Promise<PulsarDirectConnection> {
  const certificate = new RTCCertificate(
    PULSAR_KEY_PEM,
    PULSAR_CERT_PEM,
    PULSAR_SIGNATURE_HASH as any,
  );
  const srtpProfiles: (1 | 7)[] = [7, 1];

  const iceTransportStub = { connection: transport } as any;

  const dtlsTransport = new RTCDtlsTransport(
    {
      dtls: {
        keys: {
          certPem: PULSAR_CERT_PEM,
          keyPem: PULSAR_KEY_PEM,
          signatureHash: PULSAR_SIGNATURE_HASH,
        },
      },
      debug: {},
    } as any,
    iceTransportStub,
    certificate,
    srtpProfiles,
  );

  const dummyFingerprint = new RTCDtlsFingerprint('sha-256', PULSAR_FINGERPRINT);
  dtlsTransport.setRemoteParams(new RTCDtlsParameters([dummyFingerprint], 'client'));
  (dtlsTransport as any).role = 'client';

  const sctpTransport = new RTCSctpTransport(5000);
  sctpTransport.setDtlsTransport(dtlsTransport);

  await dtlsTransport.start();
  console.log('[webrtc-direct] DTLS connected');

  await sctpTransport.start(5000);
  console.log('[webrtc-direct] SCTP connected');

  const keepalive = new RTCDataChannel(
    sctpTransport as any,
    new RTCDataChannelParameters({
      label: KEEPALIVE_LABEL,
      ordered: true,
      id: 0,
      negotiated: true,
    }),
  );
  keepalive.onopen = () => console.log('[webrtc-direct] keepalive DC open');

  // ── Build connection object ──

  const conn = new PulsarDirectConnection(dtlsTransport, sctpTransport, keepalive, transport);

  return conn;
}

// ── PulsarDirectServer ───────────────────────────────────────────

type Session = {
  transport: PeerTransport;
};

/**
 * WebRTC Direct transport server for Deno.
 *
 * Listens for WebRTC Direct connections with fixed ICE credentials and a fixed
 * DTLS certificate. Multiple clients can connect to the same UDP port —
 * the server demultiplexes by source address.
 *
 * Usage:
 * ```ts
 * const server = new PulsarDirectServer(socket);
 * server.onconnection = (conn) => { ... };
 * server.onerror = (err) => { ... };
 * ```
 */
export class PulsarDirectServer {
  private _closed = false;
  private _socket: Deno.DatagramConn;

  /** Called when a new client has completed the DTLS/SCTP handshake. */
  onconnection: ((conn: PulsarDirectConnection) => void) | null = null;

  /** Called when a session fails before the handshake completes. */
  onerror: ((err: Error) => void) | null = null;

  constructor(socket: Deno.DatagramConn) {
    this._socket = socket;
    this._listenLoop().catch((err) => {
      console.error('[webrtc-direct] listen loop error:', err);
    });
  }

  private async _listenLoop() {
    const socket = this._socket!;
    const sessions = new Map<string, Session>();

    while (!this._closed) {
      try {
        const [data, addr] = await socket.receive();
        const netAddr = addr as Deno.NetAddr;
        const key = `${netAddr.hostname}:${netAddr.port}`;

        if (isStunBindingRequest(data)) {
          const response = buildStunResponse(data, netAddr);
          if (response) socket.send(response, addr);

          if (!sessions.has(key)) {
            const transport = new PeerTransport(socket, netAddr);
            const session: Session = { transport };
            sessions.set(key, session);

            startSession(transport)
              .then((conn) => {
                this.onconnection?.(conn);
              })
              .catch((err) => {
                console.error(`[webrtc-direct] session ${key} failed:`, err);
                sessions.delete(key);
                this.onerror?.(err);
              });
          }
        } else {
          const session = sessions.get(key);
          if (session) {
            session.transport.feed(data);
          }
        }
      } catch (err) {
        if (!this._closed) console.error('[webrtc-direct] receive error:', err);
      }
    }
  }

  close() {
    this._closed = true;
    this._socket?.close();
  }
}
