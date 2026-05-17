import { NOSTR_RELAYS, nostrTunnelId, tunnelCodeFromPubkey } from '../core/nostr.ts';
import { checkPort } from './lib/natCheck.ts';
import { openPort, type PortMapping } from './lib/upnp.ts';
import { PulsarDirectServer } from './lib/connection/direct.ts';
import { PulsarNostrServer } from './lib/connection/nostr.ts';
import { wireTunnel } from './lib/tunnel.ts';

const PORT = 4393;

// ── Helpers ────────────────────────────────────────────────────────

function writeLine(msg: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(`\r${msg}\n`));
}

function writeStatus(msg: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(`\r${msg}`));
}

// ── Try Pulsar Direct mode (requires --unstable-net) ───────────────

try {
  if (typeof Deno.listenDatagram !== 'function') {
    throw new Error('Deno.listenDatagram not available (need --unstable-net)');
  }

  const socket = Deno.listenDatagram({ port: PORT, transport: 'udp' });

  // ── NAT / UPnP ──────────────────────────────────────────────────

  writeStatus(`⏳ Checking port ${PORT}...`);
  let result = await checkPort(socket, PORT);
  writeLine(
    result.isPublic
      ? `✅ Port ${PORT} is public (${result.publicAddress!.ip}:${result.publicAddress!.port})`
      : `❌ Port ${PORT} is not public — ${result.reason}`,
  );
  let mapping: PortMapping | undefined;

  if (!result.isPublic) {
    console.log(`↪️ Trying UPnP to forward port ${PORT}...`);
    try {
      mapping = await openPort(PORT);
      writeStatus(`⏳ Checking port ${PORT} after UPnP mapping created...`);
      result = await checkPort(socket, PORT);
      if (result.isPublic) {
        writeLine(
          `✅ ${PORT} is public (${result.publicAddress!.ip}:${result.publicAddress!.port})`,
        );
      } else {
        await mapping.close();
        mapping = undefined;
        writeLine(`❌ UPnP mapping did not make port ${PORT} public — ${result.reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeLine(`❌ UPnP failed: ${msg}`);
    }
  }

  if (!result.publicAddress || !result.isPublic) {
    socket.close();
    console.log(
      `❌ Failed to set up Pulsar Direct. Tried to host ${PORT} at ${result.publicAddress?.ip}:${result.publicAddress?.port}, failed as ${result.reason}.`,
    );
    throw new Error('Direct mode unavailable');
  }

  const publicIp = result.publicAddress.ip;
  writeLine(`✅ Pulsar Direct ready on ${publicIp}`);

  // ── Start Pulsar direct server ──────────────────────────────────

  const server = new PulsarDirectServer(socket);

  server.onconnection = (conn) => {
    console.log(`[webrtc-direct] client connected!`);
    console.log(`[webrtc-direct] keepalive channel state: ${conn.keepalive.readyState}`);

    wireTunnel(conn);

    conn.keepalive.onclose = () => {
      console.log('[webrtc-direct] keepalive channel closed');
    };
  };

  server.onerror = (err) => {
    console.error('[webrtc-direct] server error:', err);
  };
} catch (err) {
  const directErr = err instanceof Error ? err.message : String(err);
  console.log(`↪️ ${directErr}`);

  // ── Fall back to Nostr signaling ────────────────────────────────
  console.log('↪️ Falling back to Nostr relay signaling...');
  const nostrServer = new PulsarNostrServer();

  try {
    const { pubkey } = await nostrServer.start();
    console.log(`✅ Pulsar Nostr mode ready`);
    console.log(`Listening on relays:`);
    for (const relay of NOSTR_RELAYS) console.log(`  - ${relay}`);
    console.log(`Server pubkey: ${pubkey}`);
    console.log(`Tunnel code: ${tunnelCodeFromPubkey(pubkey)}`);
    console.log(`Waiting for client connections...`);

    nostrServer.onconnection = (conn) => {
      console.log(`[nostr] Tunnel connection established!`);
      wireTunnel(conn);

      conn.keepalive.onclose = () => {
        console.log('[nostr] keepalive channel closed');
      };
    };

    nostrServer.onerror = (err) => {
      console.error('[nostr] server error:', err);
    };
  } catch (nostrErr) {
    console.error(
      `❌ Nostr mode also failed: ${
        nostrErr instanceof Error ? nostrErr.message : String(nostrErr)
      }`,
    );
    Deno.exit(1);
  }
}
