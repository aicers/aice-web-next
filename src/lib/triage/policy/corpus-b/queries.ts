import "server-only";

import { parse } from "graphql";

/**
 * Corpus B `eventListWithTriage` query. Differs from the cadence's
 * query in two load-bearing ways:
 *
 *   - `triage` is populated (policies + exclusions); the resolver
 *     therefore runs Stage 1 exclusion pre-cut and attaches
 *     `triageScores` for every matching policy.
 *   - Selection set carries the scoring fields the runner persists
 *     into `policy_triaged_event.policy_triage_snapshot`, plus the
 *     normalized-column source fields the runner needs to re-apply
 *     exclusions app-side before INSERT (closes the TLS / NTLM gap
 *     from aicers/review-database#723).
 *
 * Edge `cursor` is selected so the runner can derive `event_key`
 * straight into `policy_triaged_event.event_key` (NUMERIC(39, 0));
 * the per-event `id` is not needed because identity flows through
 * the cursor, matching the cadence pager's contract.
 *
 * The query is validated against `schemas/review.graphql` by
 * `src/__tests__/lib/graphql/schema-validation.test.ts` at CI time.
 */
export const CORPUS_B_EVENT_LIST_QUERY = parse(`
  query CorpusBEventListWithTriage(
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
          triageScores {
            policyId
            score
          }
          ... on BlocklistDns {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on BlocklistHttp {
            origAddr
            respAddr
            origPort
            respPort
            host
            uri
          }
          ... on BlocklistNtlm {
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
          ... on HttpThreat {
            origAddr
            respAddr
            origPort
            respPort
            clusterId
            host
            uri
          }
          ... on LockyRansomware {
            origAddr
            respAddr
            origPort
            respPort
            query
          }
          ... on NonBrowser {
            origAddr
            respAddr
            origPort
            respPort
            host
            uri
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
