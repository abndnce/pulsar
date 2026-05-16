import { localIp } from "./localIp.ts";

const MCAST = "239.255.255.250";
const LEASE = 120; // seconds

export type PortMapping = {
  port: number;
  protocol: string;
  /** Remove the port mapping from the router */
  close: () => Promise<void>;
  /** Re-AddPortMapping to extend the lease */
  refresh: () => Promise<void>;
};

/**
 * Open a port on the router via UPnP IGD.
 *
 * Auto-renews the lease every ~90s so the mapping stays alive while
 * the process runs. Returns a handle with `close()` to tear it down
 * and `refresh()` to manually bump the lease.
 */
export async function openPort(
  port: number,
  protocol = "UDP",
): Promise<PortMapping> {
  // ---- 1. Discover router via SSDP ----
  const sock = Deno.listenDatagram({
    transport: "udp",
    port: 0,
    reuseAddress: true,
  });
  const search = new TextEncoder().encode(
    [
      "M-SEARCH * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      'MAN: "ssdp:discover"',
      "MX: 2",
      "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
      "",
      "",
    ].join("\r\n"),
  );
  await sock.send(search, { hostname: MCAST, port: 1900, transport: "udp" });

  let loc = "";
  for (let i = 0; i < 10; i++) {
    const result = await Promise.race([
      sock.receive().then(([data]) => data),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (!result) break; // no more responses within timeout
    const msg = new TextDecoder().decode(result);
    if (msg.includes("InternetGatewayDevice")) {
      loc = msg.match(/location: (.*)/i)?.[1] || "";
      if (loc) break;
    }
  }
  sock.close();
  if (!loc) throw new Error("UPnP: no InternetGatewayDevice found");

  // ---- 2. Fetch device XML, find control URL ----
  const xml = await (await fetch(loc)).text();
  const ctrl = xml.match(
    /WAN(IP|PPP)Connection:1[\s\S]*?<controlURL>(.*?)<\/controlURL>/,
  )?.[2];
  if (!ctrl) throw new Error("UPnP: no WAN connection control URL found");

  const svc = xml.includes("WANPPPConnection:1")
    ? "urn:schemas-upnp-org:service:WANPPPConnection:1"
    : "urn:schemas-upnp-org:service:WANIPConnection:1";
  const base = loc.slice(0, loc.lastIndexOf("/"));
  const url = ctrl.startsWith("/") ? base + ctrl : base + "/" + ctrl;

  // ---- 3. Get local IP ----
  const ip = await localIp(new URL(loc).hostname);

  // ---- 4. SOAP helpers ----
  const soap = (action: string, body: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${svc}#${action}"`,
      },
      body: `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:${action} xmlns:u="${svc}">${body}</u:${action}></s:Body></s:Envelope>`,
    });

  // Returns the Response for the initial check
  const addMappingRaw = () =>
    soap(
      "AddPortMapping",
      [
        "<NewRemoteHost></NewRemoteHost>",
        `<NewExternalPort>${port}</NewExternalPort>`,
        `<NewProtocol>${protocol}</NewProtocol>`,
        `<NewInternalPort>${port}</NewInternalPort>`,
        `<NewInternalClient>${ip}</NewInternalClient>`,
        "<NewEnabled>1</NewEnabled>",
        "<NewPortMappingDescription>pulsar</NewPortMappingDescription>",
        `<NewLeaseDuration>${LEASE}</NewLeaseDuration>`,
      ].join(""),
    );

  const addMapping = (): Promise<void> => addMappingRaw().then(() => {});
  const deleteMapping = (): Promise<void> =>
    soap(
      "DeletePortMapping",
      [
        "<NewRemoteHost></NewRemoteHost>",
        `<NewExternalPort>${port}</NewExternalPort>`,
        `<NewProtocol>${protocol}</NewProtocol>`,
      ].join(""),
    ).then(() => {});

  // ---- 5. Create initial mapping ----
  const res = await addMappingRaw();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `UPnP AddPortMapping failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  // ---- 6. Auto-renew every ~3/4 of the lease ----
  let closed = false;
  const renewTimer = setInterval(async () => {
    if (closed) return;
    try {
      await addMapping();
    } catch {
      // best-effort
    }
  }, LEASE * 750); // 90s

  return {
    port,
    protocol,
    close: async () => {
      closed = true;
      clearInterval(renewTimer);
      try {
        await deleteMapping();
      } catch {
        // router might not support DeletePortMapping; lease will expire
      }
    },
    refresh: addMapping,
  };
}
