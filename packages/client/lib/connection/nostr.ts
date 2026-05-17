import {
  closeNostrReq,
  decryptSignal,
  encryptSignal,
  generateNostrKeypair,
  isAddressedTo,
  makeDiscoveryFilter,
  makeSignalEvent,
  makeSignalingFilter,
  NOSTR_RELAYS,
  parseNostrMessage,
  sendNostrEvent,
  sendNostrReq,
  type SignalingPayload,
  type SignedNostrEvent,
  signNostrEvent,
  verifyNostrEvent,
} from "../../../core/nostr.ts";
import {
  DEFAULT_ICE_SERVERS,
  waitForIceGathering,
  waitForPeerConnectionConnected,
} from "../../../core/webrtc.ts";
import { KEEPALIVE_LABEL } from "../../../core/constants.ts";
import { waitForDataChannelOpen } from "../socket-channel.ts";
import type { PulsarClientConnection } from "./types.ts";

function connectRelay(url: string, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection to ${url} timed out`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to connect to ${url}`));
    });
  });
}

async function connectToServerRelay(
  pubkeyPrefix?: string,
): Promise<{ ws: WebSocket; serverPubkey: string }> {
  const errors: string[] = [];

  for (const relayUrl of NOSTR_RELAYS) {
    let ws: WebSocket | undefined;
    try {
      ws = await connectRelay(relayUrl);
      console.log(`[nostr] Connected to ${relayUrl}`);
      const serverPubkey = await findServer(ws, pubkeyPrefix);
      return { ws, serverPubkey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${relayUrl}: ${message}`);
      console.warn(`[nostr] ${relayUrl}: ${message}`);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(`Failed to find a Pulsar server: ${errors.join("; ")}`);
}

function makeSubId(prefix: string): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(16).slice(2);
  return `${prefix}-${random}`;
}

async function findServer(
  ws: WebSocket,
  pubkeyPrefix?: string,
  timeoutMs = 15_000,
): Promise<string> {
  const subId = makeSubId("pulsar-discover");

  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      closeNostrReq(ws, subId);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            pubkeyPrefix
              ? `No Pulsar server with tunnel code "pulsar${pubkeyPrefix}" found`
              : "No Pulsar server found on Nostr relay",
          ),
        );
      });
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const msg = parseNostrMessage(event.data);
      if (!msg || msg[0] !== "EVENT" || msg[1] !== subId) return;

      void (async () => {
        const relayEvent = msg[2];
        if (!await verifyNostrEvent(relayEvent)) return;
        if (pubkeyPrefix && !relayEvent.pubkey.startsWith(pubkeyPrefix)) {
          return;
        }

        finish(() => resolve(relayEvent.pubkey));
      })().catch(() => {});
    };

    ws.addEventListener("message", onMessage);
    sendNostrReq(ws, subId, makeDiscoveryFilter());
  });
}

function waitForSignalEvent(
  ws: WebSocket,
  recipientPubkey: string,
  expectedSenderPubkey: string,
  timeoutMs = 30_000,
): Promise<SignedNostrEvent> {
  const subId = makeSubId("pulsar-answer");

  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      closeNostrReq(ws, subId);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for Nostr answer")));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const msg = parseNostrMessage(event.data);
      if (!msg || msg[0] !== "EVENT" || msg[1] !== subId) return;

      void (async () => {
        const relayEvent = msg[2];
        if (relayEvent.pubkey !== expectedSenderPubkey) return;
        if (!isAddressedTo(relayEvent, recipientPubkey)) return;
        if (!await verifyNostrEvent(relayEvent)) return;
        finish(() => resolve(relayEvent));
      })().catch(() => {});
    };

    ws.addEventListener("message", onMessage);
    sendNostrReq(ws, subId, makeSignalingFilter(recipientPubkey));
  });
}

class NostrClientConnection implements PulsarClientConnection {
  constructor(
    public readonly keepalive: RTCDataChannel,
    public readonly pc: RTCPeerConnection,
    private readonly ws: WebSocket,
  ) {}

  async close() {
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
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function connectNostr(
  tunnelCode?: string,
): Promise<PulsarClientConnection> {
  const pubkeyPrefix = tunnelCode
    ? tunnelCode.replace(/^pulsar/, "").slice(0, 4)
    : undefined;

  console.log(
    "[nostr] Looking up Pulsar tunnel" +
      (pubkeyPrefix ? ` (code ${tunnelCode})` : "") +
      "...",
  );

  const { ws, serverPubkey } = await connectToServerRelay(pubkeyPrefix);
  let pc: RTCPeerConnection | undefined;

  try {
    console.log(`[nostr] Found server: ${serverPubkey.slice(0, 16)}...`);

    const clientKeys = generateNostrKeypair();
    console.log(`[nostr] Client pubkey: ${clientKeys.pubkey.slice(0, 16)}...`);

    pc = new RTCPeerConnection({ iceServers: [...DEFAULT_ICE_SERVERS] });
    const keepalive = pc.createDataChannel(KEEPALIVE_LABEL, { ordered: true });
    keepalive.binaryType = "arraybuffer";

    const keepaliveReady = waitForDataChannelOpen(keepalive, pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const localDesc = pc.localDescription;
    if (!localDesc) throw new Error("Failed to create local offer");

    const offerPayload: SignalingPayload = {
      type: "offer",
      sdp: localDesc.sdp,
    };
    const encryptedOffer = await encryptSignal(
      JSON.stringify(offerPayload),
      clientKeys.seckey,
      serverPubkey,
    );
    const offerEvent = await signNostrEvent(
      makeSignalEvent(clientKeys.pubkey, serverPubkey, encryptedOffer),
      clientKeys.seckey,
    );

    const answerPromise = waitForSignalEvent(
      ws,
      clientKeys.pubkey,
      serverPubkey,
    );

    sendNostrEvent(ws, offerEvent);
    console.log("[nostr] Sent encrypted offer, waiting for answer...");

    const answerEvent = await answerPromise;
    const answerPlaintext = await decryptSignal(
      answerEvent.content,
      clientKeys.seckey,
      serverPubkey,
    );
    const answerPayload = JSON.parse(answerPlaintext) as SignalingPayload;

    if (answerPayload.type !== "answer" || !answerPayload.sdp) {
      throw new Error("Invalid answer from server");
    }

    console.log("[nostr] Received answer, connecting WebRTC...");
    await pc.setRemoteDescription({ type: "answer", sdp: answerPayload.sdp });
    await waitForPeerConnectionConnected(pc);
    await keepaliveReady;

    console.log("[nostr] WebRTC connected");
    return new NostrClientConnection(keepalive, pc, ws);
  } catch (err) {
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}
