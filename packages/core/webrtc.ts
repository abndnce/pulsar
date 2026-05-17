export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
] as const;

export const ICE_GATHER_TIMEOUT_MS = 3_000;
export const CONNECTION_TIMEOUT_MS = 30_000;

type EventLikePeerConnection = {
  iceGatheringState: string;
  connectionState: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

export async function waitForIceGathering(
  pc: EventLikePeerConnection,
  timeoutMs = ICE_GATHER_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  if (pc.connectionState === "failed" || pc.connectionState === "closed") {
    throw new Error(`Peer connection ${pc.connectionState}`);
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      pc.removeEventListener("connectionstatechange", onConnectionStateChange);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };

    const onCandidate = (event: Event) => {
      if (
        !("candidate" in event) || !(event as { candidate?: unknown }).candidate
      ) {
        cleanup();
        resolve();
      }
    };

    const onConnectionStateChange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error(`Peer connection ${pc.connectionState}`));
      }
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
    pc.addEventListener("connectionstatechange", onConnectionStateChange);
  });
}

export async function waitForPeerConnectionConnected(
  pc: EventLikePeerConnection,
  timeoutMs = CONNECTION_TIMEOUT_MS,
): Promise<void> {
  if (pc.connectionState === "connected") return;
  if (
    pc.connectionState === "failed" ||
    pc.connectionState === "disconnected" ||
    pc.connectionState === "closed"
  ) {
    throw new Error(`Connection failed: ${pc.connectionState}`);
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      pc.removeEventListener("connectionstatechange", onStateChange);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`WebRTC connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onStateChange = () => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        cleanup();
        reject(new Error(`Connection failed: ${pc.connectionState}`));
      }
    };

    pc.addEventListener("connectionstatechange", onStateChange);
  });
}
