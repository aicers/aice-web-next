import type { Event, EventBase, ThreatLevel } from "@/lib/detection/types";

/**
 * Friendly names for the curated `Event` subtypes. Used by the
 * investigation page header and the MITRE / category rendering in
 * the Context tab.
 *
 * Keep this table in sync with `CURATED_EVENT_TYPENAMES` in
 * `@/lib/detection/types` — the event-typename test enforces that
 * every curated typename remains a real implementor of the `Event`
 * interface, but a missing friendly name here simply falls back to
 * the raw `__typename`.
 */
export const EVENT_KIND_FRIENDLY_NAMES: Record<string, string> = {
  BlocklistBootp: "Blocklist BOOTP",
  BlocklistConn: "Blocklist Connection",
  BlocklistDceRpc: "Blocklist DCE/RPC",
  BlocklistDhcp: "Blocklist DHCP",
  BlocklistDns: "Blocklist DNS",
  BlocklistFtp: "Blocklist FTP",
  BlocklistHttp: "Blocklist HTTP",
  BlocklistKerberos: "Blocklist Kerberos",
  BlocklistLdap: "Blocklist LDAP",
  BlocklistMalformedDns: "Blocklist Malformed DNS",
  BlocklistMqtt: "Blocklist MQTT",
  BlocklistNfs: "Blocklist NFS",
  BlocklistNtlm: "Blocklist NTLM",
  BlocklistRadius: "Blocklist RADIUS",
  BlocklistRdp: "Blocklist RDP",
  BlocklistSmb: "Blocklist SMB",
  BlocklistSmtp: "Blocklist SMTP",
  BlocklistSsh: "Blocklist SSH",
  BlocklistTls: "Blocklist TLS",
  CryptocurrencyMiningPool: "Cryptocurrency Mining Pool",
  DnsCovertChannel: "DNS Covert Channel",
  DomainGenerationAlgorithm: "Domain Generation Algorithm",
  ExternalDdos: "External DDoS",
  ExtraThreat: "Extra Threat",
  FtpBruteForce: "FTP Brute Force",
  FtpPlainText: "FTP Plain Text",
  HttpThreat: "HTTP Threat",
  LdapBruteForce: "LDAP Brute Force",
  LdapPlainText: "LDAP Plain Text",
  LockyRansomware: "Locky Ransomware",
  MultiHostPortScan: "Multi-Host Port Scan",
  NetworkThreat: "Network Threat",
  NonBrowser: "Non-Browser",
  PortScan: "Port Scan",
  RdpBruteForce: "RDP Brute Force",
  RepeatedHttpSessions: "Repeated HTTP Sessions",
  SuspiciousTlsTraffic: "Suspicious TLS Traffic",
  TorConnection: "Tor Connection",
  TorConnectionConn: "Tor Connection (Conn)",
  UnusualDestinationPattern: "Unusual Destination Pattern",
  WindowsThreat: "Windows Threat",
};

export function levelBadgeVariant(
  level: ThreatLevel,
): "default" | "secondary" | "destructive" | "outline" {
  switch (level) {
    case "HIGH":
      return "destructive";
    case "MEDIUM":
      return "default";
    default:
      return "secondary";
  }
}

/**
 * Produce a short "origAddr → respAddr" summary for the header.
 *
 * Three addressing shapes exist across the curated `Event` subtypes:
 *
 * - Both singular (the common case): render `A → B`.
 * - Singular originator + array responder (e.g. `MultiHostPortScan`,
 *   `RdpBruteForce`): render `A → B[0]` with a `+N` suffix when the
 *   responder array carries more entries. Picking the first entry
 *   keeps the heading one-line; the Endpoints tab lists every row.
 * - Array originator + singular responder (`ExternalDdos`): the
 *   symmetric case — render `A[0] → B` with a `+N` suffix.
 *
 * Returns null only when neither side carries a usable address, in
 * which case the caller suppresses the summary rather than guessing.
 */
export function formatEndpointSummary(event: Event | EventBase): string | null {
  const source = event as Partial<{
    origAddr: string;
    origAddrs: string[];
    respAddr: string;
    respAddrs: string[];
  }>;

  const orig = pickAddress(source.origAddr, source.origAddrs);
  const resp = pickAddress(source.respAddr, source.respAddrs);
  if (!orig || !resp) return null;

  const extras = extraCount(source.origAddrs) + extraCount(source.respAddrs);
  const base = `${orig.value} → ${resp.value}`;
  return extras > 0 ? `${base} +${extras}` : base;
}

function pickAddress(
  singular: string | undefined,
  plural: string[] | undefined,
): { value: string } | null {
  if (singular) return { value: singular };
  if (Array.isArray(plural) && plural.length > 0 && plural[0]) {
    return { value: plural[0] };
  }
  return null;
}

function extraCount(plural: string[] | undefined): number {
  if (!Array.isArray(plural) || plural.length <= 1) return 0;
  return plural.length - 1;
}
