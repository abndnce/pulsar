/** Get the local IP used to reach a given hostname (connects on port 80). */
export async function localIp(hostname: string): Promise<string> {
  const tcp = await Deno.connect({ hostname, port: 80 });
  const ip = (tcp.localAddr as Deno.NetAddr).hostname;
  tcp.close();
  return ip;
}
