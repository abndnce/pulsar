import {
  KEEPALIVE_LABEL,
  PULSAR_FINGERPRINT,
  PULSAR_PWD,
  PULSAR_UFRAG,
} from "../../../core/constants.ts";
import { waitForPeerConnectionConnected } from "../../../core/webrtc.ts";
import { waitForDataChannelOpen } from "../socket-channel.ts";
import type { PulsarClientConnection } from "./types.ts";

// ── connectDirect ─────────────────────────────────────────────────

/**
 * Connect to a remote Pulsar server in direct mode.
 *
 * Designed for browsers, using the native `RTCPeerConnection` API.
 *
 * @param host  Server IP address
 * @param port  Server UDP port
 * @returns A connected PulsarClientConnection with an open keepalive channel
 *          and a `connect()` helper for opening socket tunnels.
 */
export async function connectDirect(
  host: string,
  port: number,
): Promise<PulsarClientConnection> {
  const pc = new RTCPeerConnection();

  // Create the keepalive data channel (mandated by Pulsar spec)
  const keepalive = pc.createDataChannel(KEEPALIVE_LABEL, {
    ordered: true,
  });

  // Generate an offer and set it as the local description.
  // We do NOT munge the SDP — the server doesn't validate the client's
  // ICE credentials or DTLS fingerprint (STUN MESSAGE-INTEGRITY is
  // unchecked, DTLS cert verification is disabled). The browser's
  // self-generated credentials work fine for the local side.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // ---- Craft the remote (server) SDP ----
  //
  //   v=0
  //   o=- 111 222 IN IP4 0.0.0.0
  //   s=-
  //   t=0 0
  //   m=application [PORT] UDP/DTLS/SCTP webrtc-datachannel
  //   c=IN IP4 [IP]
  //   a=ice-ufrag:pulsar
  //   a=ice-pwd:pulsarpulsarpulsarpuls
  //   a=fingerprint:sha-256 F1:85:10:8F:36:FF:58:D8:D0:4B:52:D7:ED:DC:5C:28:AE:7D:DB:54:0E:2A:DD:C7:C3:94:EA:A1:27:D0:4E:78
  //   a=setup:active
  //   a=mid:0
  //   a=sctp-port:5000
  //
  // Note: the trailing empty string ensures a final \r\n so that
  // Chrome's GetLine (webrtc_sdp.cc) finds a '\n' terminator for the
  // last line. Candidates are added via Trickle ICE after setting the
  // remote description.
  const remoteSdp = [
    "v=0",
    "o=- 111 222 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`,
    `c=IN IP4 ${host}`,
    `a=ice-ufrag:${PULSAR_UFRAG}`,
    `a=ice-pwd:${PULSAR_PWD}`,
    `a=fingerprint:sha-256 ${PULSAR_FINGERPRINT}`,
    "a=setup:active",
    "a=mid:0",
    "a=sctp-port:5000",
    "",
  ].join("\r\n");

  await pc.setRemoteDescription({ type: "answer", sdp: remoteSdp });

  // Provide the server's ICE candidate via Trickle ICE
  await pc.addIceCandidate({
    candidate: `candidate:1 1 UDP 2130706431 ${host} ${port} typ host`,
    sdpMid: "0",
    sdpMLineIndex: 0,
  });

  // Wait for ICE, DTLS, SCTP, and the required keepalive channel.
  await waitForPeerConnectionConnected(pc);
  await waitForDataChannelOpen(keepalive, pc);

  return {
    keepalive,
    pc,
    async close() {
      keepalive.close();
      pc.close();
    },
  };
}
