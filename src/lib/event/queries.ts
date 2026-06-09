import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { type DocumentNode, parse } from "graphql";

import type { RecordTypeId } from "./record-types";

/**
 * GraphQL documents for the Event menu's Giganto data layer.
 *
 * Every document is loaded from a checked-in `.graphql` file under
 * `src/lib/event/queries/` so the schema-validation test in
 * `src/__tests__/lib/graphql/schema-validation.test.ts` can validate
 * each document against `schemas/giganto.graphql` — the SDL of the
 * service (Giganto) that actually answers these queries. The whole
 * directory is routed to the Giganto SDL by `pickSchemaForQueryFile`,
 * so files here do not need a `giganto-` filename prefix (unlike the
 * mixed-target `src/lib/node/queries/external/` directory).
 *
 * Mirrors the loader in `src/lib/node/queries.ts`: `parse()` runs once
 * at module init via `fs.readFileSync` (no Next.js webpack loader for
 * `.graphql` imports — the BFF only runs server-side), and downstream
 * callers receive an already-parsed `DocumentNode`.
 */

// Resolved from `process.cwd()` rather than `__dirname` for the same
// reason as `src/lib/node/queries.ts`: Turbopack rewrites `__dirname`
// to a virtual path during route bundling. `process.cwd()` is the
// project root in dev, build, and tests; in standalone runtime it is
// the standalone output directory, which the `outputFileTracingIncludes`
// entry in `next.config.ts` populates with the same relative
// `src/lib/event/queries/` tree.
const QUERIES_DIR = path.join(process.cwd(), "src", "lib", "event", "queries");

/**
 * Operations declare fragment dependencies via a header line of the
 * form `# requires: <relative-path>`. Each referenced file is read
 * from disk, transitively resolved, and prepended to the operation
 * source before parsing — so a fragment shared by multiple operations
 * (e.g. `conn-fields.graphql`) lives in exactly one source-of-truth
 * `.graphql` file and the schema-validation test sees the same composed
 * document the runtime does.
 */
const REQUIRES_DIRECTIVE = /^#\s*requires:\s*(\S+)\s*$/;

function readRequires(source: string): string[] {
  const requires: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) break;
    const match = REQUIRES_DIRECTIVE.exec(line);
    if (match?.[1]) requires.push(match[1]);
  }
  return requires;
}

function composeSource(
  relativePath: string,
  visited: Set<string> = new Set(),
): string {
  if (visited.has(relativePath)) return "";
  visited.add(relativePath);
  const full = path.join(QUERIES_DIR, relativePath);
  const source = readFileSync(full, "utf8");
  const dependencies = readRequires(source).map((req) =>
    path.posix.join(path.posix.dirname(relativePath), req),
  );
  const parts = dependencies.map((dep) => composeSource(dep, visited));
  parts.push(source);
  return parts.join("\n");
}

function loadDocument(relativePath: string): DocumentNode {
  return parse(composeSource(relativePath));
}

// ── Giganto network-event operations ───────────────────────────────
//
// One document per `<type>RawEvents` query. Filenames are the kebab-case
// of the operation name; the descriptor registry pairs each constant
// with its record type and response key. `conn` keeps its dedicated
// fragment file (`conn-fields.graphql`) from E0; the other 19 inline the
// node selection since none is shared.

export const CONN_QUERY = loadDocument("conn-raw-events.graphql");
export const DNS_QUERY = loadDocument("dns-raw-events.graphql");
export const MALFORMEDDNS_QUERY = loadDocument(
  "malformed-dns-raw-events.graphql",
);
export const HTTP_QUERY = loadDocument("http-raw-events.graphql");
export const RDP_QUERY = loadDocument("rdp-raw-events.graphql");
export const SMTP_QUERY = loadDocument("smtp-raw-events.graphql");
export const NTLM_QUERY = loadDocument("ntlm-raw-events.graphql");
export const KERBEROS_QUERY = loadDocument("kerberos-raw-events.graphql");
export const SSH_QUERY = loadDocument("ssh-raw-events.graphql");
export const DCERPC_QUERY = loadDocument("dce-rpc-raw-events.graphql");
export const FTP_QUERY = loadDocument("ftp-raw-events.graphql");
export const MQTT_QUERY = loadDocument("mqtt-raw-events.graphql");
export const LDAP_QUERY = loadDocument("ldap-raw-events.graphql");
export const TLS_QUERY = loadDocument("tls-raw-events.graphql");
export const SMB_QUERY = loadDocument("smb-raw-events.graphql");
export const NFS_QUERY = loadDocument("nfs-raw-events.graphql");
export const BOOTP_QUERY = loadDocument("bootp-raw-events.graphql");
export const DHCP_QUERY = loadDocument("dhcp-raw-events.graphql");
export const RADIUS_QUERY = loadDocument("radius-raw-events.graphql");
export const ICMP_QUERY = loadDocument("icmp-raw-events.graphql");

/**
 * Record type → its `<type>RawEvents` document. This lives in the
 * server-only loader (not the client-safe descriptor registry) so the
 * `fs`-backed `parse()` calls never reach the browser bundle. The
 * server action keys into it by `EventFilter.recordType`.
 */
export const RAW_EVENT_QUERIES: Record<RecordTypeId, DocumentNode> = {
  conn: CONN_QUERY,
  dns: DNS_QUERY,
  malformedDns: MALFORMEDDNS_QUERY,
  http: HTTP_QUERY,
  rdp: RDP_QUERY,
  smtp: SMTP_QUERY,
  ntlm: NTLM_QUERY,
  kerberos: KERBEROS_QUERY,
  ssh: SSH_QUERY,
  dceRpc: DCERPC_QUERY,
  ftp: FTP_QUERY,
  mqtt: MQTT_QUERY,
  ldap: LDAP_QUERY,
  tls: TLS_QUERY,
  smb: SMB_QUERY,
  nfs: NFS_QUERY,
  bootp: BOOTP_QUERY,
  dhcp: DHCP_QUERY,
  radius: RADIUS_QUERY,
  icmp: ICMP_QUERY,
};

/** Back-compat alias for E0 call sites. */
export const CONN_RAW_EVENTS_QUERY = CONN_QUERY;
export const EVENT_SENSORS_QUERY = loadDocument("sensors.graphql");
export const STATISTICS_QUERY = loadDocument("statistics.graphql");
