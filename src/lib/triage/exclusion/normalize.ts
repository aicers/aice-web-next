/**
 * Event-kind → exclusion-matching column normalization.
 *
 * This is the single mapping the cadence runner (#481), the corpus B
 * runner (#460), and the retroactive-DELETE planner (#457) all share so
 * cadence-time and retroactive paths target the same normalized columns
 * and never double-apply.
 */

import type { TriageEvent } from "../types";
import type { NormalizedEventColumns } from "./types";

/**
 * Curated typename groups. The cadence pager fetches every standard-
 * filter survivor regardless of subtype; the normalization step decides
 * which physical columns each subtype contributes to. The groups below
 * mirror the field-shape distinctions the existing `TRIAGE_EVENT_LIST_QUERY`
 * already encodes (HTTP / DNS / TLS / NTLM / IP-only).
 */
const HTTP_TYPENAMES: ReadonlySet<string> = new Set([
  "BlocklistHttp",
  "HttpThreat",
  "NonBrowser",
  "DomainGenerationAlgorithm",
  "RepeatedHttpSessions",
]);

const DNS_TYPENAMES: ReadonlySet<string> = new Set([
  "BlocklistDns",
  "CryptocurrencyMiningPool",
  "DnsCovertChannel",
  "LockyRansomware",
]);

const TLS_TYPENAMES: ReadonlySet<string> = new Set([
  "BlocklistTls",
  "SuspiciousTlsTraffic",
]);

/**
 * NTLM is the IP-only carve-out (anchored in aicers/review-database#723):
 * even though the upstream resolver may expose a `hostname` field,
 * cadence intentionally leaves `host` / `dns_query` / `uri` NULL so the
 * cadence-time and retroactive-DELETE paths agree. Domain / Hostname /
 * Uri exclusions therefore never match an NTLM row, by design.
 */
const NTLM_TYPENAMES: ReadonlySet<string> = new Set(["BlocklistNtlm"]);

/**
 * Map one `TriageEvent` to the normalized exclusion-matching columns.
 * Address fields are taken straight from the event (already populated
 * for every IP-bearing subtype the curated query selects). The host /
 * dnsQuery / uri columns follow the typename group:
 *
 *   - HTTP group: `host` ← `event.host`, `uri` ← `event.uri`
 *   - TLS group: `host` ← `event.serverName`
 *   - DNS group: `dnsQuery` ← `event.query`
 *   - NTLM group: all three NULL (IP-only carve-out)
 *   - Anything else: all three NULL
 */
export function normalizeEventColumns(
  event: TriageEvent,
): NormalizedEventColumns {
  const origAddr = nonEmpty(event.origAddr);
  const respAddr = nonEmpty(event.respAddr);

  if (NTLM_TYPENAMES.has(event.__typename)) {
    return { origAddr, respAddr, host: null, dnsQuery: null, uri: null };
  }
  if (HTTP_TYPENAMES.has(event.__typename)) {
    return {
      origAddr,
      respAddr,
      host: nonEmpty(event.host),
      dnsQuery: null,
      uri: nonEmpty(event.uri),
    };
  }
  if (TLS_TYPENAMES.has(event.__typename)) {
    return {
      origAddr,
      respAddr,
      host: nonEmpty(event.serverName),
      dnsQuery: null,
      uri: null,
    };
  }
  if (DNS_TYPENAMES.has(event.__typename)) {
    return {
      origAddr,
      respAddr,
      host: null,
      dnsQuery: nonEmpty(event.query),
      uri: null,
    };
  }
  return { origAddr, respAddr, host: null, dnsQuery: null, uri: null };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.length === 0) return null;
  return value;
}

/**
 * Test-only mirror of the typename groups above so a regression in the
 * mapping fails the unit test rather than silently slipping through to
 * production.
 */
export const _testing = {
  HTTP_TYPENAMES,
  DNS_TYPENAMES,
  TLS_TYPENAMES,
  NTLM_TYPENAMES,
};
