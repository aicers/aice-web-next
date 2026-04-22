/**
 * Built-in MITRE ATT&CK catalogue used by the Investigation page's
 * Context tab. The lookup is keyed first by the event's
 * `attackKind` (when present) and falls back to the `category`
 * (REview's `ThreatCategory`, treated as a MITRE tactic).
 *
 * The shape is intentionally narrow:
 *   - `tacticId` / `tacticName` map a `ThreatCategory` value to its
 *     canonical MITRE ATT&CK tactic identifier (TA0001 etc.).
 *   - `techniqueId` / `techniqueName` and the optional
 *     `subTechniqueId` / `subTechniqueName` are filled in only for
 *     `attackKind` values where REview's classifier picks a
 *     specific technique.
 *   - `explanation` is the descriptive text rendered in the
 *     Explanation card.
 *
 * Coverage is deliberately curated rather than exhaustive — the
 * catalogue is the extension point for follow-ups (and for merging
 * REview-sourced strings later behind the same lookup), not the
 * place where every MITRE technique is listed.
 *
 * Source: https://attack.mitre.org/ (Enterprise matrix v15).
 */

import type { ThreatCategory } from "@/lib/detection/types";

export interface MitreContext {
  tacticId?: string;
  tacticName?: string;
  techniqueId?: string;
  techniqueName?: string;
  subTechniqueId?: string;
  subTechniqueName?: string;
  explanation?: string;
}

const TACTIC_BY_CATEGORY: Record<ThreatCategory, { id: string; name: string }> =
  {
    RECONNAISSANCE: { id: "TA0043", name: "Reconnaissance" },
    RESOURCE_DEVELOPMENT: { id: "TA0042", name: "Resource Development" },
    INITIAL_ACCESS: { id: "TA0001", name: "Initial Access" },
    EXECUTION: { id: "TA0002", name: "Execution" },
    PERSISTENCE: { id: "TA0003", name: "Persistence" },
    PRIVILEGE_ESCALATION: { id: "TA0004", name: "Privilege Escalation" },
    DEFENSE_EVASION: { id: "TA0005", name: "Defense Evasion" },
    CREDENTIAL_ACCESS: { id: "TA0006", name: "Credential Access" },
    DISCOVERY: { id: "TA0007", name: "Discovery" },
    LATERAL_MOVEMENT: { id: "TA0008", name: "Lateral Movement" },
    COLLECTION: { id: "TA0009", name: "Collection" },
    COMMAND_AND_CONTROL: { id: "TA0011", name: "Command and Control" },
    EXFILTRATION: { id: "TA0010", name: "Exfiltration" },
    IMPACT: { id: "TA0040", name: "Impact" },
  };

interface TechniqueEntry {
  techniqueId: string;
  techniqueName: string;
  subTechniqueId?: string;
  subTechniqueName?: string;
  explanation: string;
}

/**
 * Per-`attackKind` entries. Keys are matched case-insensitively
 * against `event.attackKind`. Add new entries as REview surfaces
 * additional kinds — this is the single extension point for
 * MITRE-aware Context content.
 */
const TECHNIQUE_BY_ATTACK_KIND: Record<string, TechniqueEntry> = {
  "port scan": {
    techniqueId: "T1046",
    techniqueName: "Network Service Discovery",
    explanation:
      "Port scan: a single source probed multiple ports on the responder. Check the scanned-port breadth and duration for reconnaissance patterns.",
  },
  "multi-host port scan": {
    techniqueId: "T1046",
    techniqueName: "Network Service Discovery",
    explanation:
      "Multi-host port scan: a single source probed multiple ports across multiple responders, indicating broad network reconnaissance.",
  },
  "dns covert channel": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    subTechniqueId: "T1071.004",
    subTechniqueName: "DNS",
    explanation:
      "DNS covert channel: the query pattern resembles tunnelled traffic. Inspect the query name, qtype and answer lengths for exfiltration indicators.",
  },
  "domain generation algorithm": {
    techniqueId: "T1568",
    techniqueName: "Dynamic Resolution",
    subTechniqueId: "T1568.002",
    subTechniqueName: "Domain Generation Algorithms",
    explanation:
      "Domain Generation Algorithm: queried hostnames look algorithmically generated, a common C2 fallback pattern.",
  },
  "ftp brute force": {
    techniqueId: "T1110",
    techniqueName: "Brute Force",
    subTechniqueId: "T1110.001",
    subTechniqueName: "Password Guessing",
    explanation:
      "FTP brute force: repeated authentication attempts against an FTP service. Cross-reference the user list against known accounts.",
  },
  "rdp brute force": {
    techniqueId: "T1110",
    techniqueName: "Brute Force",
    subTechniqueId: "T1110.001",
    subTechniqueName: "Password Guessing",
    explanation:
      "RDP brute force: repeated authentication attempts against a Remote Desktop service. Look for account-lockout signals and source-IP reputation.",
  },
  "ldap brute force": {
    techniqueId: "T1110",
    techniqueName: "Brute Force",
    subTechniqueId: "T1110.001",
    subTechniqueName: "Password Guessing",
    explanation:
      "LDAP brute force: repeated authentication attempts against a directory service. Verify whether targeted accounts are privileged.",
  },
  "tor connection": {
    techniqueId: "T1090",
    techniqueName: "Proxy",
    subTechniqueId: "T1090.003",
    subTechniqueName: "Multi-hop Proxy",
    explanation:
      "Tor connection: traffic egressed through (or ingressed from) the Tor network — anonymising channel often used for command and control.",
  },
  "external ddos": {
    techniqueId: "T1498",
    techniqueName: "Network Denial of Service",
    explanation:
      "External DDoS: distributed flood targeting an external responder. Investigate volume, packet shape, and downstream impact.",
  },
  "blocklist conn": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    explanation:
      "Blocklisted connection: the peer matches a known-bad address or network in the intelligence feed.",
  },
  "http threat": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    subTechniqueId: "T1071.001",
    subTechniqueName: "Web Protocols",
    explanation:
      "HTTP-based threat: the session matched a signature in the threat-intelligence database. Review the URI, User-Agent and response code for indicators.",
  },
  "non browser": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    subTechniqueId: "T1071.001",
    subTechniqueName: "Web Protocols",
    explanation:
      "Non-browser HTTP traffic: the User-Agent does not match a known browser, suggesting tooling or automation.",
  },
  "repeated http sessions": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    subTechniqueId: "T1071.001",
    subTechniqueName: "Web Protocols",
    explanation:
      "Repeated HTTP sessions: a single client opened many sessions in a short window — beaconing or scraping pattern.",
  },
  "suspicious tls traffic": {
    techniqueId: "T1573",
    techniqueName: "Encrypted Channel",
    subTechniqueId: "T1573.002",
    subTechniqueName: "Asymmetric Cryptography",
    explanation:
      "Suspicious TLS traffic: the handshake or certificate metadata diverges from baseline. Inspect SNI, JA3, and cert chain.",
  },
  "windows threat": {
    techniqueId: "T1059",
    techniqueName: "Command and Scripting Interpreter",
    explanation:
      "Windows-host threat: detection rule fired on Windows endpoint telemetry. Pivot to the host's process and parent-process tree.",
  },
  "network threat": {
    techniqueId: "T1071",
    techniqueName: "Application Layer Protocol",
    explanation:
      "Network threat: generic pattern match against the packet stream. Review the matched content and attack kind for context.",
  },
};

/** Fallback explanations keyed by the curated `__typename`. */
const EXPLANATION_BY_TYPENAME: Record<string, string> = {
  HttpThreat: TECHNIQUE_BY_ATTACK_KIND["http threat"].explanation,
  DnsCovertChannel: TECHNIQUE_BY_ATTACK_KIND["dns covert channel"].explanation,
  PortScan: TECHNIQUE_BY_ATTACK_KIND["port scan"].explanation,
  MultiHostPortScan:
    TECHNIQUE_BY_ATTACK_KIND["multi-host port scan"].explanation,
  BlocklistConn: TECHNIQUE_BY_ATTACK_KIND["blocklist conn"].explanation,
  FtpBruteForce: TECHNIQUE_BY_ATTACK_KIND["ftp brute force"].explanation,
  RdpBruteForce: TECHNIQUE_BY_ATTACK_KIND["rdp brute force"].explanation,
  LdapBruteForce: TECHNIQUE_BY_ATTACK_KIND["ldap brute force"].explanation,
  NetworkThreat: TECHNIQUE_BY_ATTACK_KIND["network threat"].explanation,
  TorConnection: TECHNIQUE_BY_ATTACK_KIND["tor connection"].explanation,
  TorConnectionConn: TECHNIQUE_BY_ATTACK_KIND["tor connection"].explanation,
  DomainGenerationAlgorithm:
    TECHNIQUE_BY_ATTACK_KIND["domain generation algorithm"].explanation,
  ExternalDdos: TECHNIQUE_BY_ATTACK_KIND["external ddos"].explanation,
  NonBrowser: TECHNIQUE_BY_ATTACK_KIND["non browser"].explanation,
  RepeatedHttpSessions:
    TECHNIQUE_BY_ATTACK_KIND["repeated http sessions"].explanation,
  SuspiciousTlsTraffic:
    TECHNIQUE_BY_ATTACK_KIND["suspicious tls traffic"].explanation,
  WindowsThreat: TECHNIQUE_BY_ATTACK_KIND["windows threat"].explanation,
};

/**
 * Resolve MITRE context for an event. Order of preference:
 *   1. `attackKind` lookup (technique + sub-technique).
 *   2. `__typename` lookup (explanation only).
 *   3. `category` lookup (tactic only).
 *
 * Returns `null` when nothing matches; the renderer should
 * collapse the section in that case.
 */
export function lookupMitreContext(input: {
  __typename: string;
  attackKind?: string | null;
  category?: ThreatCategory | null;
}): MitreContext | null {
  const result: MitreContext = {};

  if (input.category) {
    const tactic = TACTIC_BY_CATEGORY[input.category];
    if (tactic) {
      result.tacticId = tactic.id;
      result.tacticName = tactic.name;
    }
  }

  const kindKey =
    typeof input.attackKind === "string"
      ? input.attackKind.trim().toLowerCase()
      : "";
  const technique = kindKey ? TECHNIQUE_BY_ATTACK_KIND[kindKey] : undefined;
  if (technique) {
    result.techniqueId = technique.techniqueId;
    result.techniqueName = technique.techniqueName;
    result.subTechniqueId = technique.subTechniqueId;
    result.subTechniqueName = technique.subTechniqueName;
    result.explanation = technique.explanation;
  } else {
    const fallback = EXPLANATION_BY_TYPENAME[input.__typename];
    if (fallback) result.explanation = fallback;
  }

  const hasContent =
    result.tacticId ||
    result.techniqueId ||
    result.subTechniqueId ||
    result.explanation;
  return hasContent ? result : null;
}
