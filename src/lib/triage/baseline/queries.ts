import "server-only";

import { parse } from "graphql";

/**
 * Cadence-side `eventListWithTriage` query (1B-1 / discussion #447 §3.4).
 *
 * The cadence runner asks the resolver for raw standard-filter survivors —
 * `triage = null`, no inline exclusions, no inline policies — so the
 * edge cursors correspond to events that have not been pre-cut by the
 * resolver's Stage 1 path. This is the property the cadence relies on
 * to advance `last_event_cursor` reliably even when subsequent app-side
 * exclusion re-application drops every event in the page.
 *
 * The selection set carries only what the cadence's per-page pipeline
 * needs:
 *
 *   - Interface fields (`__typename`, `time`, `sensor`, `category`,
 *     `level`, `confidence`) for every event.
 *   - IP / port fields on every IP-bearing curated subtype so
 *     `orig_addr` / `resp_addr` / `orig_port` / `resp_port` populate
 *     for `observed_event_meta` and `baseline_triaged_event`.
 *   - HTTP-shape fields (`host`, `uri`) on the HTTP-shaped subtypes.
 *   - TLS-shape `serverName` on the TLS-shaped subtypes (cadence maps
 *     it to the `host` exclusion-matching column).
 *   - DNS-shape `query` on the DNS-shaped subtypes (cadence maps it
 *     to the `dns_query` exclusion-matching column).
 *   - `clusterId` on `HttpThreat` so `baselineScore` can detect the
 *     unlabeled-`HttpThreat` cluster-none bonus.
 *
 * No `origNetwork` / `respNetwork` membership shapes — cadence does
 * not classify against the customer perimeter; that is the menu's
 * job. Skipping the membership selection keeps the page payload
 * small and the resolver round-trip fast.
 *
 * Edge `cursor` is selected so the cadence can derive the per-event
 * `event_key` for the corpus tables' primary key (review encodes the
 * RocksDB i128 as a base64 cursor; see `cursorToEventKey` in the
 * cadence runner).
 *
 * The query is validated against `schemas/review.graphql` by
 * `src/__tests__/lib/graphql/schema-validation.test.ts` at CI time.
 */
export const EVENT_LIST_WITH_TRIAGE_QUERY = parse(`
  query CadenceEventListWithTriage(
    $filter: EventStandardFilterInput!
    $triage: EventTriageInput
    $first: Int
    $after: String
  ) {
    eventListWithTriage(
      filter: $filter
      triage: $triage
      first: $first
      after: $after
    ) {
      pageInfo {
        hasPreviousPage
        hasNextPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          __typename
          time
          sensor
          category
          level
          confidence
          ... on BlocklistBootp {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistConn {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistDceRpc {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistDhcp {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistDns {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on BlocklistFtp {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistHttp {
            origAddr
            respAddr
            origPort
            respPort
            host
            uri
          }
          ... on BlocklistKerberos {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistLdap {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistMqtt {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistNfs {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistNtlm {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistRadius {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistRdp {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistSmb {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistSmtp {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistSsh {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on BlocklistTls {
            origAddr
            respAddr
            origPort
            respPort
            serverName
          }
          ... on CryptocurrencyMiningPool {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on DnsCovertChannel {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on DomainGenerationAlgorithm {
            origAddr
            respAddr
            origPort
            respPort
            host
            uri
          }
          ... on FtpBruteForce {
            origAddr
            respAddr
            respPort
          }
          ... on FtpPlainText {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on HttpThreat {
            origAddr
            respAddr
            origPort
            respPort
            clusterId
            host
            uri
          }
          ... on LdapBruteForce {
            origAddr
            respAddr
            respPort
          }
          ... on LdapPlainText {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on LockyRansomware {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on MultiHostPortScan {
            origAddr
            respPort
          }
          ... on NetworkThreat {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on NonBrowser {
            origAddr
            respAddr
            origPort
            respPort
            host
            uri
          }
          ... on PortScan {
            origAddr
            respAddr
          }
          ... on RdpBruteForce {
            origAddr
          }
          ... on RepeatedHttpSessions {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on SuspiciousTlsTraffic {
            origAddr
            respAddr
            origPort
            respPort
            serverName
          }
          ... on TorConnection {
            origAddr
            respAddr
            origPort
            respPort
          }
          ... on TorConnectionConn {
            origAddr
            respAddr
            origPort
            respPort
          }
        }
      }
    }
  }
`);
