const MAGIC_COOKIE = 0x2112a442;
const STUN_SERVER: Deno.NetAddr = {
  hostname: 'stun.voipgate.com',
  port: 3478,
  transport: 'udp',
};

export type NatCheckResult = {
  isPublic: boolean;
  publicAddress?: { ip: string; port: number };
  reason?: string;
};

/**
 * Probe whether a UDP port is publicly reachable using RFC 5780 STUN
 * NAT behaviour discovery.
 *
 * @param conn  The already-bound UDP socket to probe on
 * @param port  The local port the socket is bound to
 */
export async function checkPort(conn: Deno.DatagramConn, port: number): Promise<NatCheckResult> {
  // Stage 1: Send binding request, wait for OTHER-ADDRESS
  const probe = createStunPacket(0, false);
  await conn.send(probe, STUN_SERVER);

  const result = await recvWithTimeout(conn, 2000);
  if (!result) {
    return { isPublic: false, reason: 'STUN server did not respond' };
  }

  const [pkt] = result;
  const dv = new DataView(pkt.buffer);
  if (dv.getUint32(4) != MAGIC_COOKIE) {
    return { isPublic: false, reason: 'Bad STUN response' };
  }

  const attrs = parseStunAttributes(pkt);
  if (!attrs.otherAddress || !attrs.xorAddress) {
    return { isPublic: false, reason: 'STUN server does not support RFC 5780' };
  }

  // Symmetric NAT check
  if (attrs.xorAddress.port != port) {
    return {
      isPublic: false,
      reason: 'Symmetric NAT detected',
      publicAddress: attrs.xorAddress,
    };
  }

  // Stage 2: Send CHANGE-REQUEST, check if response arrives from the other address
  const changeReq = createStunPacket(0x06, true);
  await conn.send(changeReq, STUN_SERVER);

  while (true) {
    const pkt2 = await recvWithTimeout(conn, 2000);
    if (!pkt2) {
      return {
        isPublic: false,
        reason: 'No response received / address-based filtering',
        publicAddress: attrs.xorAddress,
      };
    }

    const [data, from] = pkt2;
    const dv2 = new DataView(data.buffer);
    if (dv2.getUint32(4) != MAGIC_COOKIE) continue;

    if ((from as Deno.NetAddr).hostname == attrs.otherAddress.hostname) {
      return { isPublic: true, publicAddress: attrs.xorAddress };
    }
  }
}

function recvWithTimeout(conn: Deno.DatagramConn, ms: number) {
  const recv: Promise<[Uint8Array, Deno.Addr]> = conn.receive().catch(() => null as never);
  return Promise.race([recv, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

function parseStunAttributes(data: Uint8Array) {
  const v = new DataView(data.buffer);
  let xorAddress: { ip: string; port: number } | undefined,
    otherAddress: { hostname: string; port: number } | undefined;
  let pos = 20;
  const end = 20 + v.getUint16(2);

  while (pos < end) {
    const type = v.getUint16(pos);
    const len = v.getUint16(pos + 2);
    pos += 4;

    if (type == 0x0020) {
      xorAddress = {
        port: v.getUint16(pos + 2) ^ (MAGIC_COOKIE >>> 16),
        ip: formatIp(v.getUint32(pos + 4) ^ MAGIC_COOKIE),
      };
    } else if (type == 0x802c) {
      otherAddress = {
        hostname: formatIp(v.getUint32(pos + 4)),
        port: v.getUint16(pos + 2),
      };
    }
    pos += (len + 3) & ~3;
  }
  return { xorAddress, otherAddress };
}

function createStunPacket(changeValue: number, includeAttr: boolean) {
  const bodyLen = includeAttr ? 8 : 0;
  const buf = new Uint8Array(20 + bodyLen);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0x0001);
  v.setUint16(2, bodyLen);
  v.setUint32(4, MAGIC_COOKIE);
  crypto.getRandomValues(buf.subarray(8, 20));
  if (includeAttr) {
    v.setUint16(20, 0x0003);
    v.setUint16(22, 0x0004);
    v.setUint32(24, changeValue);
  }
  return buf;
}

function formatIp(raw: number) {
  return [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.');
}
