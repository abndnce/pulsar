import {
  decryptSignal,
  encryptSignal,
  generateNostrKeypair,
  isAddressedTo,
  makeDiscoveryEvent,
  makeSignalEvent,
  makeSignalingFilter,
  NOSTR_RELAYS,
  type NostrKeypair,
  parseNostrMessage,
  sendNostrEvent,
  sendNostrReq,
  SIGNALING_KIND,
  type SignalingPayload,
  type SignedNostrEvent,
  signNostrEvent,
  tunnelCodeFromPubkey,
  verifyNostrEvent,
} from '../../core/nostr.ts';
import { DEFAULT_ICE_SERVERS, waitForIceGathering } from '../../core/webrtc.ts';
import { KEEPALIVE_LABEL } from '../../core/constants.ts';
import { parseSocketDestination, type SocketDestination } from '../../core/socket.ts';
import { WispClient } from './wisp-client';

export type NostrPhase = 'connecting' | 'connected' | 'failed';

export type WispPhase = 'disconnected' | 'connecting' | 'connected' | 'failed';

export type NostrConnStatus = {
  url: string;
  state: 'connecting' | 'connected' | 'failed';
  error?: string;
};

export type RelayUpdate = {
  nostrPhase: NostrPhase;
  nostrStatuses: NostrConnStatus[];
  tunnelCode?: string;
  wispPhase: WispPhase;
};

type NostrConnection = {
  ws: WebSocket;
  url: string;
};

export class PulsarRelay {
  private nostrConns: NostrConnection[] = [];
  private wisp: WispClient | null = null;
  private keypair: NostrKeypair | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private seenEventIds = new Set<string>();
  private nostrStatuses: NostrConnStatus[] = [];
  private nostrPhase: NostrPhase = 'connecting';
  private wispPhase: WispPhase = 'disconnected';
  private tunnelCode: string | undefined;
  private onUpdate: ((update: RelayUpdate) => void) | null = null;
  private initPromise: Promise<void> | null = null;

  get currentTunnelCode() {
    return this.tunnelCode;
  }

  get currentNostrStatuses() {
    return this.nostrStatuses;
  }

  setUpdateCallback(cb: (update: RelayUpdate) => void) {
    this.onUpdate = cb;
  }

  /** Connect to Nostr relays eagerly. Safe to call multiple times. */
  async initNostr(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initNostrInternal();
    return this.initPromise;
  }

  private async initNostrInternal(): Promise<void> {
    this.closeNostrConnections();
    this.keypair = generateNostrKeypair();
    this.tunnelCode = tunnelCodeFromPubkey(this.keypair.pubkey);
    this.seenEventIds.clear();

    this.nostrPhase = 'connecting';
    this.emit();

    await this.connectNostrRelays();

    if (!this.nostrConns.length) {
      this.nostrPhase = 'failed';
      this.emit();
      return;
    }

    await this.publishDiscovery();
    for (const conn of this.nostrConns) this.subscribeSignaling(conn);

    this.nostrPhase = 'connected';
    this.emit();
  }

  /** Connect to a Wisp server. Nostr must be connected first. */
  async connectWisp(url: string): Promise<void> {
    this.wispPhase = 'connecting';
    this.emit();

    this.wisp?.close();
    this.wisp = null;

    try {
      this.wisp = new WispClient(url);
      this.wisp.onclose = () => {
        if (this.wispPhase === 'connected' || this.wispPhase === 'connecting') {
          this.wispPhase = 'disconnected';
          this.emit();
        }
      };

      await this.wisp.connected;

      this.wispPhase = 'connected';
      this.emit();
    } catch (err) {
      this.wisp?.close();
      this.wisp = null;
      this.wispPhase = 'failed';
      this.emit();
      throw err;
    }
  }

  /** Disconnect only the Wisp connection, keeping Nostr alive. */
  disconnectWisp(): void {
    this.wisp?.close();
    this.wisp = null;
    this.wispPhase = 'disconnected';
    this.emit();
  }

  /** Full teardown: close everything, Nostr and Wisp. */
  stop(): void {
    this.closeConnections();
    this.keypair = null;
    this.tunnelCode = undefined;
    this.nostrStatuses = [];
    this.initPromise = null;
    this.nostrPhase = 'connecting';
    this.wispPhase = 'disconnected';
    this.emit();
  }

  // ---- private ----

  private async connectNostrRelays(): Promise<void> {
    this.nostrStatuses = NOSTR_RELAYS.map((url) => ({
      url,
      state: 'connecting',
    }));
    this.emit();

    await Promise.allSettled(NOSTR_RELAYS.map((url) => this.connectOneNostr(url)));
    this.emit();
  }

  private connectOneNostr(url: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        this.updateNostrStatus(url, { state: 'failed', error: 'Timed out' });
        ws.close();
        resolve();
      }, 8_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        this.nostrConns.push({ ws, url });
        this.updateNostrStatus(url, { state: 'connected', error: undefined });
        resolve();
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        this.updateNostrStatus(url, {
          state: 'failed',
          error: 'Connection error',
        });
        resolve();
      });

      ws.addEventListener('close', () => {
        const idx = this.nostrConns.findIndex((conn) => conn.ws === ws);
        if (idx !== -1) this.nostrConns.splice(idx, 1);
        this.updateNostrStatus(url, {
          state: 'failed',
          error: 'Disconnected',
        });

        if (this.nostrPhase === 'connected' && !this.nostrConns.length) {
          this.nostrPhase = 'failed';
          this.emit();
        }
      });
    });
  }

  private async publishDiscovery(): Promise<void> {
    if (!this.keypair) throw new Error('Missing relay keypair');

    const discovery = await signNostrEvent(
      makeDiscoveryEvent(this.keypair.pubkey),
      this.keypair.seckey,
    );
    for (const conn of this.nostrConns) sendNostrEvent(conn.ws, discovery);
  }

  private subscribeSignaling(conn: NostrConnection): void {
    if (!this.keypair) throw new Error('Missing relay keypair');

    const subId = `pulsar-signal-${this.keypair.pubkey.slice(0, 8)}`;
    sendNostrReq(conn.ws, subId, makeSignalingFilter(this.keypair.pubkey));

    conn.ws.addEventListener('message', (event) => {
      const msg = parseNostrMessage(event.data);
      if (!msg || msg[0] !== 'EVENT' || msg[1] !== subId) return;

      this.handleSignalingEvent(msg[2], conn.ws).catch((err) => {
        console.error('[relay] Failed to handle signaling event', err);
      });
    });
  }

  private async handleSignalingEvent(event: SignedNostrEvent, relayWs: WebSocket): Promise<void> {
    if (!this.keypair) return;
    if (this.seenEventIds.has(event.id)) return;
    if (event.kind !== SIGNALING_KIND) return;
    if (!isAddressedTo(event, this.keypair.pubkey)) return;
    if (!(await verifyNostrEvent(event))) return;

    this.seenEventIds.add(event.id);

    let payload: SignalingPayload;
    try {
      payload = JSON.parse(
        await decryptSignal(event.content, this.keypair.seckey, event.pubkey),
      ) as SignalingPayload;
    } catch (err) {
      console.error('[relay] Could not decrypt signaling event', err);
      return;
    }

    if (payload.type === 'offer' && payload.sdp) {
      await this.handleOffer(event.pubkey, payload.sdp, relayWs);
      return;
    }

    if (payload.type === 'ice' && payload.candidate) {
      await this.handleIceCandidate(event.pubkey, payload);
    }
  }

  private async handleOffer(clientPubkey: string, sdp: string, relayWs: WebSocket): Promise<void> {
    if (!this.keypair) throw new Error('Missing relay keypair');

    const previous = this.peerConnections.get(clientPubkey);
    if (previous) {
      try {
        previous.close();
      } catch {
        /* ignore */
      }
    }

    const pc = new RTCPeerConnection({ iceServers: [...DEFAULT_ICE_SERVERS] });
    this.peerConnections.set(clientPubkey, pc);

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.peerConnections.delete(clientPubkey);
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
    });
    pc.ondatachannel = (event) => this.handleDataChannel(event.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    const localDesc = pc.localDescription;
    if (!localDesc) throw new Error('Missing local description');

    const encrypted = await encryptSignal(
      JSON.stringify({ type: 'answer', sdp: localDesc.sdp } satisfies SignalingPayload),
      this.keypair.seckey,
      clientPubkey,
    );
    const answerEvent = await signNostrEvent(
      makeSignalEvent(this.keypair.pubkey, clientPubkey, encrypted),
      this.keypair.seckey,
    );
    sendNostrEvent(relayWs, answerEvent);
    this.emit();
  }

  private async handleIceCandidate(clientPubkey: string, payload: SignalingPayload): Promise<void> {
    const pc = this.peerConnections.get(clientPubkey);
    if (!pc || !payload.candidate) return;

    await pc.addIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid ?? '0',
      sdpMLineIndex: payload.sdpMLineIndex ?? 0,
    });
  }

  private handleDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (channel.label === KEEPALIVE_LABEL) return;

    let destination: SocketDestination;
    try {
      destination = parseSocketDestination(channel.label);
    } catch {
      channel.close();
      return;
    }

    const wisp = this.wisp;
    if (!wisp) {
      channel.close();
      return;
    }

    let stream;
    try {
      stream = wisp.connect(destination.hostname, destination.port);
    } catch {
      channel.close();
      return;
    }

    stream.ondata = (data) => {
      if (channel.readyState === 'open') channel.send(data);
    };
    stream.onclose = () => closeDataChannel(channel);

    channel.onmessage = (event) => {
      try {
        stream.sendToStream(toUint8Array(event.data));
      } catch {
        stream.close(0x03);
        closeDataChannel(channel);
      }
    };
    channel.onclose = () => stream.close(0x02);
    channel.onerror = () => stream.close(0x03);
  }

  private updateNostrStatus(url: string, patch: Partial<NostrConnStatus>) {
    const idx = this.nostrStatuses.findIndex((status) => status.url === url);
    if (idx === -1) return;

    this.nostrStatuses[idx] = { ...this.nostrStatuses[idx], ...patch };
    this.emit();
  }

  private emit() {
    this.onUpdate?.({
      nostrPhase: this.nostrPhase,
      nostrStatuses: this.nostrStatuses,
      tunnelCode: this.tunnelCode,
      wispPhase: this.wispPhase,
    });
  }

  private closeNostrConnections() {
    for (const conn of this.nostrConns) {
      try {
        conn.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.nostrConns.length = 0;

    for (const pc of this.peerConnections.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peerConnections.clear();
  }

  private closeConnections() {
    this.closeNostrConnections();
    this.wisp?.close();
    this.wisp = null;
    this.nostrStatuses = [];
  }
}

function closeDataChannel(channel: RTCDataChannel): void {
  if (channel.readyState === 'closed' || channel.readyState === 'closing') {
    return;
  }
  channel.close();
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('Unsupported data channel payload');
}
