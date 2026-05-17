const PACKET_TYPE_CONNECT = 0x01;
const PACKET_TYPE_DATA = 0x02;
const PACKET_TYPE_CONTINUE = 0x03;
const PACKET_TYPE_CLOSE = 0x04;
const PACKET_TYPE_INFO = 0x05;
const STREAM_TYPE_TCP = 0x01;

export class WispStream {
  private bufferRemaining = 0;
  private pendingData: Uint8Array[] = [];
  private closed = false;

  ondata: ((data: Uint8Array) => void) | null = null;
  onclose: ((reason?: number) => void) | null = null;

  constructor(
    readonly streamId: number,
    readonly hostname: string,
    readonly port: number,
    initialBuffer: number,
    private readonly send: (type: number, streamId: number, payload: Uint8Array) => void,
  ) {
    this.bufferRemaining = initialBuffer;
  }

  grantBuffer(size: number) {
    this.bufferRemaining += size;
    this.flushPending();
  }

  receiveData(data: Uint8Array) {
    this.ondata?.(data);
  }

  close(reason = 0x01) {
    if (this.closed) return;
    this.closed = true;
    this.send(PACKET_TYPE_CLOSE, this.streamId, new Uint8Array([reason]));
    this.onclose?.(reason);
  }

  sendToStream(data: Uint8Array) {
    if (this.closed) return;

    if (this.bufferRemaining > 0) {
      this.bufferRemaining--;
      this.send(PACKET_TYPE_DATA, this.streamId, data);
      return;
    }

    this.pendingData.push(data);
  }

  remoteClose(reason: number) {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
  }

  private flushPending() {
    while (this.bufferRemaining > 0 && this.pendingData.length > 0) {
      const data = this.pendingData.shift()!;
      this.bufferRemaining--;
      this.send(PACKET_TYPE_DATA, this.streamId, data);
    }
  }
}

export class WispClient {
  private ws: WebSocket;
  private streams = new Map<number, WispStream>();
  private initialBuffer = 0;
  private handshakeComplete = false;
  private handshakeResolve: ((value: void) => void) | null = null;
  private handshakeReject: ((reason: Error) => void) | null = null;
  private usedStreamIds = new Set<number>();

  onclose: (() => void) | null = null;
  readonly connected: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url, 'wisp');
    this.ws.binaryType = 'arraybuffer';
    this.connected = new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });

    this.ws.onmessage = (event) => {
      this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
    };
    this.ws.onclose = () => {
      for (const stream of this.streams.values()) stream.remoteClose(0x03);
      this.streams.clear();
      this.usedStreamIds.clear();
      this.onclose?.();
      if (!this.handshakeComplete) {
        this.handshakeReject?.(new Error('WebSocket closed during handshake'));
      }
    };
    this.ws.onerror = () => {
      if (!this.handshakeComplete) {
        this.handshakeReject?.(new Error('WebSocket error during handshake'));
      }
    };
  }

  connect(hostname: string, port: number): WispStream {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Wisp WebSocket is not open');
    }

    const streamId = this.generateStreamId();
    const stream = new WispStream(
      streamId,
      hostname,
      port,
      this.initialBuffer,
      (type, id, payload) => this.sendPacket(type, id, payload),
    );
    this.streams.set(streamId, stream);

    const hostBytes = new TextEncoder().encode(hostname);
    const payload = new Uint8Array(3 + hostBytes.length);
    const view = new DataView(payload.buffer);
    payload[0] = STREAM_TYPE_TCP;
    view.setUint16(1, port, true);
    payload.set(hostBytes, 3);
    this.sendPacket(PACKET_TYPE_CONNECT, streamId, payload);

    return stream;
  }

  close() {
    for (const stream of this.streams.values()) stream.close(0x02);
    this.streams.clear();
    this.usedStreamIds.clear();
    this.ws.close();
  }

  private generateStreamId(): number {
    let id: number;
    do {
      id = crypto.getRandomValues(new Uint32Array(1))[0]!;
    } while (id === 0 || this.usedStreamIds.has(id));

    this.usedStreamIds.add(id);
    return id;
  }

  private sendPacket(type: number, streamId: number, payload: Uint8Array) {
    const packet = new Uint8Array(5 + payload.length);
    const view = new DataView(packet.buffer);
    packet[0] = type;
    view.setUint32(1, streamId, true);
    packet.set(payload, 5);
    this.ws.send(packet);
  }

  private handleMessage(data: Uint8Array) {
    if (data.length < 5) return;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = data[0]!;
    const streamId = view.getUint32(1, true);
    const payload = data.subarray(5);

    switch (type) {
      case PACKET_TYPE_INFO:
        this.handleInfo(payload);
        break;
      case PACKET_TYPE_CONTINUE:
        this.handleContinue(streamId, payload);
        break;
      case PACKET_TYPE_DATA:
        this.streams.get(streamId)?.receiveData(payload);
        break;
      case PACKET_TYPE_CLOSE:
        this.handleClose(streamId, payload);
        break;
    }
  }

  private handleInfo(payload: Uint8Array) {
    if (payload.length < 2) return;
    this.sendPacket(PACKET_TYPE_INFO, 0, new Uint8Array([2, 1]));
  }

  private handleContinue(streamId: number, payload: Uint8Array) {
    const bufferSize = readUint32Payload(payload, 64);

    if (streamId === 0 && !this.handshakeComplete) {
      this.initialBuffer = bufferSize;
      this.handshakeComplete = true;
      this.handshakeResolve?.();
      return;
    }

    this.streams.get(streamId)?.grantBuffer(bufferSize);
  }

  private handleClose(streamId: number, payload: Uint8Array) {
    if (streamId === 0 && !this.handshakeComplete) {
      this.handshakeReject?.(new Error('Server rejected handshake'));
      return;
    }

    const stream = this.streams.get(streamId);
    if (!stream) return;

    const reason = payload.length > 0 ? payload[0] : 0x01;
    stream.remoteClose(reason);
    this.streams.delete(streamId);
    this.usedStreamIds.delete(streamId);
  }
}

function readUint32Payload(payload: Uint8Array, fallback: number): number {
  if (payload.length < 4) return fallback;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}
