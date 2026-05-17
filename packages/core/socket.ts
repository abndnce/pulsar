import { SOCKET_PREFIX } from "./constants.ts";

export type SocketDestination = {
  hostname: string;
  port: number;
};

export function socketChannelLabel(hostname: string, port: number): string {
  return `${SOCKET_PREFIX}${formatSocketDestination(hostname, port)}`;
}

export function formatSocketDestination(
  hostname: string,
  port: number,
): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `${host}:${port}`;
}

export function parseSocketDestination(label: string): SocketDestination {
  if (!label.startsWith(SOCKET_PREFIX)) {
    throw new Error(
      `Unknown channel label "${label}" - expected prefix "${SOCKET_PREFIX}"`,
    );
  }

  const dest = label.slice(SOCKET_PREFIX.length);
  if (!dest) throw new Error(`Socket destination missing from "${label}"`);

  if (dest.startsWith("[")) {
    const closeBracket = dest.indexOf("]");
    if (closeBracket === -1 || dest[closeBracket + 1] !== ":") {
      throw new Error(`Invalid IPv6 destination "${dest}"`);
    }

    const hostname = dest.slice(1, closeBracket);
    const port = Number(dest.slice(closeBracket + 2));
    if (!isValidDestination(hostname, port)) {
      throw new Error(`Invalid IPv6 destination "${dest}"`);
    }

    return { hostname, port };
  }

  const separator = dest.lastIndexOf(":");
  if (separator === -1) {
    throw new Error(`Invalid destination "${dest}" - missing port`);
  }

  const hostname = dest.slice(0, separator);
  const port = Number(dest.slice(separator + 1));
  if (!isValidDestination(hostname, port)) {
    throw new Error(`Invalid destination "${dest}"`);
  }

  return { hostname, port };
}

function isValidDestination(hostname: string, port: number): boolean {
  return !!hostname && Number.isInteger(port) && port >= 1 && port <= 65535;
}
