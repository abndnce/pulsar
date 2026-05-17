import { checkPort } from "./lib/natCheck.ts";
import { openPort, type PortMapping } from "./lib/upnp.ts";
import { PulsarDirectServer } from "./lib/connection/direct.ts";
import { PulsarNostrServer } from "./lib/connection/nostr.ts";
import { wireTunnel } from "./lib/tunnel.ts";

const PORT = 4393;

// ── Try Pulsar Direct mode (requires --unstable-net) ───────────────

try {
  if (typeof Deno.listenDatagram !== "function") {
    throw new Error("Deno.listenDatagram not available (need --unstable-net)");
  }

  console.log(`Setting up port ${PORT}...`);
  const socket = Deno.listenDatagram({ port: PORT, transport: "udp" });

  // ── NAT / UPnP ──────────────────────────────────────────────────

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
    throw new Error("Direct mode unavailable");
  }

  const publicIp = result.publicAddress.ip;
  console.log(`✅ Pulsar Direct ready`);
  console.log(`Connect to: ${publicIp}:${PORT}`);

  // ── Start Pulsar direct server ──────────────────────────────────

  const server = new PulsarDirectServer(socket);

  server.onconnection = (conn) => {
    console.log(`[webrtc-direct] client connected!`);
    console.log(
      `[webrtc-direct] keepalive channel state: ${conn.keepalive.readyState}`,
    );

    wireTunnel(conn);

    conn.keepalive.onclose = () => {
      console.log("[webrtc-direct] keepalive channel closed");
    };
  };

  server.onerror = (err) => {
    console.error("[webrtc-direct] server error:", err);
  };

  // Keep the process alive
  await new Promise(() => {});
} catch (err) {
  const directErr = err instanceof Error ? err.message : String(err);
  console.log(`↪️ Pulsar Direct unavailable: ${directErr}`);

  // ── Fall back to Nostr signaling ────────────────────────────────
  console.log("↪️ Falling back to Nostr relay signaling...");
  const nostrServer = new PulsarNostrServer();

  try {
    const { pubkey } = await nostrServer.start();
    console.log(`✅ Pulsar Nostr mode ready`);
    console.log(`Server pubkey: ${pubkey}`);
    console.log(`Listening on relays:`);
    console.log(`  - wss://nostr.data.haus`);
    console.log(`  - wss://kotukonostr.onrender.com`);
    console.log(`Waiting for client connections...`);

    nostrServer.onconnection = (conn) => {
      console.log(`[nostr] Tunnel connection established!`);
      wireTunnel(conn);

      conn.keepalive.onclose = () => {
        console.log("[nostr] keepalive channel closed");
      };
    };

    nostrServer.onerror = (err) => {
      console.error("[nostr] server error:", err);
    };

    // Keep the process alive
    await new Promise(() => {});
  } catch (nostrErr) {
    console.error(
      `❌ Nostr mode also failed: ${nostrErr instanceof Error ? nostrErr.message : String(nostrErr)}`,
    );
    Deno.exit(1);
  }
}
