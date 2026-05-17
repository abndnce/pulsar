import { connectDirect, libcurlTransport } from '@abndnce/pulsar-client';
import { libcurl } from 'libcurl.js';
import libcurlWasmUrl from 'libcurl.js/libcurl.wasm?url';
import type {
  ProxyTransport,
  RawHeaders,
  WebSocketDataType,
  TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

const TUNNEL_HOST = '216.250.119.217';
const TUNNEL_PORT = 4393;

let connection: Awaited<ReturnType<typeof connectDirect>> | undefined;
let session: InstanceType<typeof libcurl.HTTPSession> | undefined;
let libcurlReady: Promise<void> | undefined;

async function ensureLibcurl() {
  if (libcurlReady) return libcurlReady;
  libcurlReady = libcurl.load_wasm(libcurlWasmUrl);
  return libcurlReady;
}

async function ensureConnected() {
  if (connection?.pc.connectionState === 'connected' && connection?.keepalive.readyState === 'open')
    return;

  connection?.close().catch(() => {});
  connection = undefined;
  session?.close();
  session = undefined;

  console.log('[pulsar] connecting to', TUNNEL_HOST + ':' + TUNNEL_PORT);
  connection = await connectDirect(TUNNEL_HOST, TUNNEL_PORT);
  console.log('[pulsar] connected');

  const factory = libcurlTransport(connection.pc);
  libcurl.transport = function (u: string) {
    return factory(u);
  } as unknown as typeof WebSocket;
  libcurl.set_websocket('wss://pulsar-tunnel.local/');
}

export class PulsarTransport implements ProxyTransport {
  ready = false;

  async init() {
    await ensureLibcurl();
    await ensureConnected();
    this.ready = true;
  }

  async request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
  ): Promise<TransferrableResponse> {
    await ensureLibcurl();
    await ensureConnected();

    if (!session) session = new libcurl.HTTPSession();

    const filtered = headers.filter(
      ([k]) => !['host', 'connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase()),
    );
    const reqBody =
      body && method !== 'GET' && method !== 'HEAD'
        ? await new Response(body).arrayBuffer()
        : undefined;

    const res = await session.fetch(remote.href, {
      method,
      headers: filtered,
      body: reqBody,
      redirect: 'manual',
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Array.isArray(res.raw_headers) ? res.raw_headers : [...res.headers],
      body: res.body ?? new ArrayBuffer(0),
    };
  }

  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (p: string, e: string) => void,
    onmessage: (d: WebSocketDataType) => void,
    onclose: (c: number, r: string) => void,
    onerror: (e: string) => void,
  ): [(d: WebSocketDataType) => void, (c: number, r: string) => void] {
    let socket: WebSocket | undefined;

    (async () => {
      await ensureLibcurl();
      await ensureConnected();
      socket = new libcurl.WebSocket(url.toString(), protocols, { headers: requestHeaders });
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => onopen('', '');
      socket.onclose = (e) => onclose(e.code, e.reason);
      socket.onerror = () => onerror('transport failed');
      socket.onmessage = (e) => onmessage(e.data);
    })();

    return [
      (d) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) throw Error('not open');
        socket.send(d);
      },
      (_c, _r) => {
        socket?.close(_c, _r);
      },
    ];
  }
}
