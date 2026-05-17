/**
 * Shared utilities for opening Pulsar socket tunnel data channels.
 *
 * These work with any RTCPeerConnection, regardless of how it was
 * established (direct, nostr, etc.).
 */

import { SOCKET_PREFIX } from "../../core/constants.ts";

/**
 * Wait for an RTCDataChannel to enter the "open" state.
 * Rejects if it closes or errors before opening.
 */
export function waitForDataChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`DataChannel open timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
    };

    channel.onopen = () => {
      cleanup();
      resolve();
    };
    channel.onclose = () => {
      cleanup();
      reject(new Error("DataChannel closed before opening"));
    };
    channel.onerror = (e) => {
      cleanup();
      reject(new Error(`DataChannel error before opening: ${e}`));
    };
  });
}

/**
 * Create a data channel on the given `pc` with the Pulsar socket label
 * convention (`socket/<hostname>:<port>`) and wait for it to open.
 *
 * This is the low-level primitive used by `connect()` and
 * `libcurlTransport()`.
 */
export function openSocketChannel(
  pc: RTCPeerConnection,
  hostname: string,
  port: number,
  timeoutMs?: number,
): Promise<RTCDataChannel> {
  const label = `${SOCKET_PREFIX}${hostname}:${port}`;
  const channel = pc.createDataChannel(label, { ordered: true });
  return waitForDataChannelOpen(channel, timeoutMs).then(() => channel);
}
