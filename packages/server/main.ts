import { checkPort } from "./lib/natCheck.ts";
import { openPort, type PortMapping } from "./lib/upnp.ts";
import { PulsarDirectServer } from "./lib/connection/direct.ts";

const PORT = 42069;

// ── Single shared UDP socket ──────────────────────────────────────

console.log(`Setting up port ${PORT}...`);
const socket = Deno.listenDatagram({ port: PORT, transport: "udp" });

// ── NAT / UPnP ────────────────────────────────────────────────────

let result = await checkPort(socket, PORT);
let mapping: PortMapping | undefined;

if (!result.isPublic) {
  console.log(`↪️ Trying UPnP to forward port ${PORT}...`);
  try {
    mapping = await openPort(PORT);
    console.log("↪️ UPnP mapping created, re-checking...");
    result = await checkPort(socket, PORT);
    if (result.isPublic) {
      console.log("↪️ UPnP good");
    } else {
      await mapping.close();
      mapping = undefined;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`↪️ UPnP failed: ${msg}`);
  }
}

if (!result.publicAddress || !result.isPublic) {
  socket.close();
  console.log(
    `❌ Failed to set up Pulsar Direct. Tried to host ${PORT} at ${result.publicAddress?.ip}:${result.publicAddress?.port}, failed as ${result.reason}.`,
  );
  Deno.exit(1);
}

const publicIp = result.publicAddress.ip;
console.log(`✅ Pulsar Direct ready`);
console.log(`Connect to: ${publicIp}:${PORT}`);

// ── Start Pulsar server ───────────────────────────────────────────

const server = new PulsarDirectServer(socket);

server.onconnection = (conn) => {
  console.log(`[webrtc-direct] client connected!`);
  console.log(
    `[webrtc-direct] keepalive channel state: ${conn.keepalive.readyState}`,
  );

  conn.keepalive.onclose = () => {
    console.log("[webrtc-direct] keepalive channel closed");
  };
};

server.onerror = (err) => {
  console.error("[webrtc-direct] server error:", err);
};
