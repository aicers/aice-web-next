/**
 * Source-of-truth for Hog (Semi-supervised Engine) `active_models`.
 *
 * aice-web feature-gates this list via the `gs` Cargo feature. aice-web-next
 * reads `NEXT_PUBLIC_GS_MODE` at module load and exposes either the base
 * subset (gs build) or the full set (default). Forms read `ACTIVE_MODELS`
 * directly — they must not branch on the flag themselves.
 *
 * Display labels live in the `nodes.forms.activeModels` namespace of the
 * i18n message bundles, keyed by `id`. The form looks them up via
 * `useTranslations`; this module only owns identity + wire format.
 *
 * See `decisions/node-field-catalog.md` ("ActiveModel enum").
 */

export interface ActiveModelDef {
  /** Strum variant — used as a stable id and as the i18n key. */
  id: string;
  /** TOML wire value (serde rename). */
  wire: string;
}

export const BASE_MODELS: readonly ActiveModelDef[] = [
  { id: "DnsCovertChannel", wire: "dns covert channel" },
  { id: "TorConnection", wire: "tor connection" },
  { id: "DomainGenerationAlgorithm", wire: "domain generation algorithm" },
  { id: "FtpPlainText", wire: "ftp plain text" },
  { id: "LdapPlainText", wire: "ldap plain text" },
  { id: "CryptocurrencyMiningPool", wire: "cryptocurrency mining pool" },
  { id: "LockyRansomware", wire: "locky ransomware" },
  { id: "SuspiciousTlsTraffic", wire: "suspicious tls traffic" },
  { id: "NonBrowser", wire: "non browser" },
  { id: "RepeatedHttpSessions", wire: "repeated http sessions" },
];

export const NON_GS_ADDITIONAL_MODELS: readonly ActiveModelDef[] = [
  { id: "RdpBruteForce", wire: "rdp brute force" },
  { id: "FtpBruteForce", wire: "ftp brute force" },
  { id: "PortScan", wire: "port scan" },
  { id: "MultiHostPortScan", wire: "multi host port scan" },
  { id: "LdapBruteForce", wire: "ldap brute force" },
  { id: "ExternalDdos", wire: "external ddos" },
  { id: "BlocklistDns", wire: "blocklist dns" },
  { id: "BlocklistConn", wire: "blocklist conn" },
  { id: "BlocklistDceRpc", wire: "blocklist dce rpc" },
  { id: "BlocklistFtp", wire: "blocklist ftp" },
  { id: "BlocklistHttp", wire: "blocklist http" },
  { id: "BlocklistKerberos", wire: "blocklist kerberos" },
  { id: "BlocklistLdap", wire: "blocklist ldap" },
  { id: "BlocklistMalformedDns", wire: "blocklist malformed dns" },
  { id: "BlocklistMqtt", wire: "blocklist mqtt" },
  { id: "BlocklistNfs", wire: "blocklist nfs" },
  { id: "BlocklistNtlm", wire: "blocklist ntlm" },
  { id: "BlocklistRadius", wire: "blocklist radius" },
  { id: "BlocklistRdp", wire: "blocklist rdp" },
  { id: "BlocklistSmb", wire: "blocklist smb" },
  { id: "BlocklistSmtp", wire: "blocklist smtp" },
  { id: "BlocklistSsh", wire: "blocklist ssh" },
  { id: "BlocklistTls", wire: "blocklist tls" },
  { id: "UnusualDestinationPattern", wire: "unusual destination pattern" },
];

const TRUTHY = new Set(["1", "true", "on"]);

export function isGsMode(rawFlag: string | undefined): boolean {
  if (rawFlag === undefined) return false;
  return TRUTHY.has(rawFlag.toLowerCase());
}

export const GS_MODE = isGsMode(process.env.NEXT_PUBLIC_GS_MODE);

/**
 * The active model list for the current build. Gs builds ship the base
 * subset; non-gs builds ship the base + additional. Forms iterate this
 * directly — they must not consult `GS_MODE` themselves.
 */
export const ACTIVE_MODELS: readonly ActiveModelDef[] = GS_MODE
  ? BASE_MODELS
  : [...BASE_MODELS, ...NON_GS_ADDITIONAL_MODELS];
