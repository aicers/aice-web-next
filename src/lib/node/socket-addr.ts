/**
 * Socket-address helpers shared by the per-service serialisers.
 *
 * The wire format mirrors Rust's `SocketAddr::to_string()`:
 * IPv4 literals are emitted as `ip:port`; IPv6 literals are emitted
 * as `[ip]:port` so the colon separating the address from the port
 * stays unambiguous.
 *
 * The matching parser handles both shapes. On a malformed input it
 * returns the supplied fallback port; the caller's Zod schema is
 * still responsible for rejecting an unparseable IP.
 */

export function formatSocketAddr(ip: string, port: number): string {
  return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
}

export interface ParsedSocketAddr {
  ip: string;
  port: number;
}

export function parseSocketAddr(
  addr: string,
  fallbackPort: number,
): ParsedSocketAddr {
  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    if (close === -1) return { ip: addr, port: fallbackPort };
    const ip = addr.slice(1, close);
    const rest = addr.slice(close + 1);
    if (!rest.startsWith(":")) return { ip, port: fallbackPort };
    const portStr = rest.slice(1);
    if (portStr.length === 0) return { ip, port: fallbackPort };
    const port = Number(portStr);
    return { ip, port: Number.isFinite(port) ? port : fallbackPort };
  }
  const colon = addr.lastIndexOf(":");
  if (colon === -1) return { ip: addr, port: fallbackPort };
  const portStr = addr.slice(colon + 1);
  if (portStr.length === 0)
    return { ip: addr.slice(0, colon), port: fallbackPort };
  const port = Number(portStr);
  return {
    ip: addr.slice(0, colon),
    port: Number.isFinite(port) ? port : fallbackPort,
  };
}
