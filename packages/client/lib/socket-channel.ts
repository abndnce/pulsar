/**
 * Shared utilities for opening Pulsar socket tunnel data channels.
 *
 * These work with any RTCPeerConnection, regardless of how it was
 * established (direct, nostr, etc.).
 */

import { SOCKET_PREFIX } from "../../core/constants.ts";

/**
 * Wait for an RTCDataChannel to enter the "open" state.
 *
 * Also monitors the RTCPeerConnection for failure/closure, and
 * accepts an optional AbortSignal for cancellation.
 *
 * Rejects if the channel closes, the peer connection fails, or
 * the timeout elapses before the channel opens.
 */
export function waitForDataChannelOpen(
  channel: RTCDataChannel,
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

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
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      pc.removeEventListener("connectionstatechange", onStateChange);
      signal?.removeEventListener("abort", onAbort);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      reject(new Error("DataChannel closed before opening"));
    };

    const onError = () => {
      cleanup();
      reject(new Error("DataChannel error before opening"));
    };

    const onStateChange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error(`Peer connection ${pc.connectionState}`));
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    channel.addEventListener("error", onError, { once: true });
    pc.addEventListener("connectionstatechange", onStateChange);
    signal?.addEventListener("abort", onAbort, { once: true });
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
  signal?: AbortSignal,
): Promise<RTCDataChannel> {
  const label = `${SOCKET_PREFIX}${hostname}:${port}`;
  const channel = pc.createDataChannel(label, { ordered: true });
  return waitForDataChannelOpen(channel, pc, timeoutMs, signal).then(() => channel);
}
