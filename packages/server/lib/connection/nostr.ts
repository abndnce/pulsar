import { RTCDataChannel, RTCDtlsTransport, RTCPeerConnection, RTCSctpTransport } from 'npm:werift';
import {
  decryptSignal,
  encryptSignal,
  generateNostrKeypair,
  isAddressedTo,
  makeDiscoveryEvent,
  makeSignalEvent,
  makeSignalingFilter,
  NOSTR_RELAYS,
  parseNostrMessage,
  sendNostrEvent,
  sendNostrReq,
  SIGNALING_KIND,
  type SignalingPayload,
  type SignedNostrEvent,
  signNostrEvent,
  tunnelCodeFromPubkey,
  verifyNostrEvent,
} from '../../../core/nostr.ts';
import { DEFAULT_ICE_SERVERS, waitForIceGathering } from '../../../core/webrtc.ts';
import { KEEPALIVE_LABEL } from '../../../core/constants.ts';
import type { TunnelWireTarget } from '../tunnel.ts';
import type { PulsarServerConnection } from './types.ts';

export class NostrServerConnection implements PulsarServerConnection, TunnelWireTarget {
  readonly tcpSockets = new Set<Deno.Conn>();

  constructor(
    public readonly dtlsTransport: RTCDtlsTransport,
    public readonly sctpTransport: RTCSctpTransport,
    public readonly keepalive: RTCDataChannel,
    private readonly pc: RTCPeerConnection,
  ) {}

  trackSocket(socket: Deno.Conn): void {
    this.tcpSockets.add(socket);
  }

  async close() {
    for (const socket of this.tcpSockets) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this.tcpSockets.clear();

    try {
      this.keepalive.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}

export class PulsarNostrServer {
  private seckey = '';
  private pubkey = '';
  private wsConnections: WebSocket[] = [];
  private peerConnections = new Map<string, RTCPeerConnection>();
  private seenEventIds = new Set<string>();
  private shuttingDown = false;

  onconnection: ((conn: NostrServerConnection) => void) | null = null;
  onerror: ((err: Error) => void) | null = null;

  async start(): Promise<{ pubkey: string }> {
    this.shuttingDown = false;
    this.seenEventIds.clear();

    const keypair = generateNostrKeypair();
    this.seckey = keypair.seckey;
    this.pubkey = keypair.pubkey;

    console.log(`[nostr] Server pubkey: ${this.pubkey}`);
    console.log(`[nostr] Tunnel code: ${tunnelCodeFromPubkey(this.pubkey)}`);

    const errors: Error[] = [];
    await Promise.all(
      NOSTR_RELAYS.map((relayUrl) =>
        this.connectToRelay(relayUrl).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          console.error(`[nostr] Failed to connect to ${relayUrl}: ${error.message}`);
        }),
      ),
    );

    if (this.wsConnections.length === 0) {
      throw new Error(
        `Failed to connect to any Nostr relay: ${errors.map((err) => err.message).join('; ')}`,
      );
    }

    console.log(`[nostr] Connected to ${this.wsConnections.length} relay(s)`);
    await this.publishDiscovery();

    for (const ws of this.wsConnections) {
      this.subscribeSignaling(ws);
    }

    return { pubkey: this.pubkey };
  }

  close() {
    this.shuttingDown = true;

    for (const ws of this.wsConnections) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.wsConnections.length = 0;

    for (const pc of this.peerConnections.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peerConnections.clear();
  }

  private async connectToRelay(relayUrl: string): Promise<void> {
    const ws = new WebSocket(relayUrl);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${relayUrl} timed out`));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error connecting to ${relayUrl}`));
      });
    });

    ws.addEventListener('close', () => {
      console.warn(`[nostr] Disconnected from ${relayUrl}`);
      const idx = this.wsConnections.indexOf(ws);
      if (idx !== -1) this.wsConnections.splice(idx, 1);
    });

    this.wsConnections.push(ws);
    console.log(`[nostr] Connected to relay: ${relayUrl}`);
  }

  private async publishDiscovery(): Promise<void> {
    const signed = await signNostrEvent(makeDiscoveryEvent(this.pubkey), this.seckey);
    this.publishSigned(signed);
    console.log('[nostr] Published discovery event');
  }

  private subscribeSignaling(ws: WebSocket): void {
    const subId = `pulsar-signal-${this.pubkey.slice(0, 8)}`;
    sendNostrReq(ws, subId, makeSignalingFilter(this.pubkey));

    ws.addEventListener('message', (event) => {
      if (this.shuttingDown) return;

      const msg = parseNostrMessage(event.data);
      if (!msg || msg[0] !== 'EVENT' || msg[1] !== subId) return;

      this.handleSignalingEvent(msg[2], ws).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[nostr] Error handling signaling event: ${error.message}`);
        this.onerror?.(error);
      });
    });
  }

  private async handleSignalingEvent(event: SignedNostrEvent, relayWs: WebSocket): Promise<void> {
    if (this.seenEventIds.has(event.id)) return;
    if (event.kind !== SIGNALING_KIND) return;
    if (!isAddressedTo(event, this.pubkey)) return;
    if (!(await verifyNostrEvent(event))) return;

    this.seenEventIds.add(event.id);

    let payload: SignalingPayload;
    try {
      const plaintext = await decryptSignal(event.content, this.seckey, event.pubkey);
      payload = JSON.parse(plaintext) as SignalingPayload;
    } catch (err) {
      console.error(`[nostr] Failed to decrypt signaling from ${event.pubkey}: ${err}`);
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
    console.log(`[nostr] Received WebRTC offer from ${clientPubkey.slice(0, 8)}`);

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

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label !== KEEPALIVE_LABEL) return;

      const sctpTransport = pc.sctpTransport;
      const dtlsTransport = sctpTransport?.dtlsTransport;
      if (!sctpTransport || !dtlsTransport) {
        this.onerror?.(new Error('Nostr peer connection missing SCTP transport'));
        return;
      }

      console.log(`[nostr] Keepalive channel open for ${clientPubkey.slice(0, 8)}`);
      this.onconnection?.(new NostrServerConnection(dtlsTransport, sctpTransport, channel, pc));
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    const localDesc = pc.localDescription;
    if (!localDesc) throw new Error('Missing local description');

    const encrypted = await encryptSignal(
      JSON.stringify({ type: 'answer', sdp: localDesc.sdp } satisfies SignalingPayload),
      this.seckey,
      clientPubkey,
    );
    const replyEvent = await signNostrEvent(
      makeSignalEvent(this.pubkey, clientPubkey, encrypted),
      this.seckey,
    );

    sendNostrEvent(relayWs, replyEvent);
    console.log(`[nostr] Sent encrypted answer to ${clientPubkey.slice(0, 8)}`);
  }

  private async handleIceCandidate(clientPubkey: string, payload: SignalingPayload): Promise<void> {
    const pc = this.peerConnections.get(clientPubkey);
    if (!pc || !payload.candidate) return;

    try {
      await pc.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid ?? '0',
        sdpMLineIndex: payload.sdpMLineIndex ?? 0,
      });
    } catch (err) {
      console.error(`[nostr] Failed to add ICE candidate: ${err}`);
    }
  }

  private publishSigned(event: SignedNostrEvent): void {
    for (const ws of this.wsConnections) {
      sendNostrEvent(ws, event);
    }
  }
}
