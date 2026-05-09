import "server-only";

import { parse } from "graphql";

/**
 * Triage `eventList` query — Phase 1.A baseline (discussion #447 §3.2).
 *
 * The selection is the minimum the baseline scoring rule and asset
 * list need: time/sensor/category/level (interface fields), origAddr
 * for the asset key, plus `clusterId` on `HttpThreat` to support the
 * "cluster_id-None bonus" branch of the baseline rule.
 *
 * The query is validated against `schemas/review.graphql` by the
 * inline-parse() walk in
 * `src/__tests__/lib/graphql/schema-validation.test.ts`.
 */
export const TRIAGE_EVENT_LIST_QUERY = parse(`
  query TriageEventList(
    $filter: EventListFilterInput!
    $first: Int
    $after: String
  ) {
    eventList(filter: $filter, first: $first, after: $after) {
      pageInfo {
        hasPreviousPage
        hasNextPage
        startCursor
        endCursor
      }
      edges {
        cursor
      }
      nodes {
        __typename
        time
        sensor
        category
        level
        ... on BlocklistBootp {
          origAddr
        }
        ... on BlocklistConn {
          origAddr
        }
        ... on BlocklistDceRpc {
          origAddr
        }
        ... on BlocklistDhcp {
          origAddr
        }
        ... on BlocklistDns {
          origAddr
        }
        ... on BlocklistFtp {
          origAddr
        }
        ... on BlocklistHttp {
          origAddr
        }
        ... on BlocklistKerberos {
          origAddr
        }
        ... on BlocklistLdap {
          origAddr
        }
        ... on BlocklistMalformedDns {
          origAddr
        }
        ... on BlocklistMqtt {
          origAddr
        }
        ... on BlocklistNfs {
          origAddr
        }
        ... on BlocklistNtlm {
          origAddr
        }
        ... on BlocklistRadius {
          origAddr
        }
        ... on BlocklistRdp {
          origAddr
        }
        ... on BlocklistSmb {
          origAddr
        }
        ... on BlocklistSmtp {
          origAddr
        }
        ... on BlocklistSsh {
          origAddr
        }
        ... on BlocklistTls {
          origAddr
        }
        ... on CryptocurrencyMiningPool {
          origAddr
        }
        ... on DnsCovertChannel {
          origAddr
        }
        ... on DomainGenerationAlgorithm {
          origAddr
        }
        ... on FtpBruteForce {
          origAddr
        }
        ... on FtpPlainText {
          origAddr
        }
        ... on HttpThreat {
          origAddr
          clusterId
        }
        ... on LdapBruteForce {
          origAddr
        }
        ... on LdapPlainText {
          origAddr
        }
        ... on LockyRansomware {
          origAddr
        }
        ... on MultiHostPortScan {
          origAddr
        }
        ... on NetworkThreat {
          origAddr
        }
        ... on NonBrowser {
          origAddr
        }
        ... on PortScan {
          origAddr
        }
        ... on RepeatedHttpSessions {
          origAddr
        }
        ... on SuspiciousTlsTraffic {
          origAddr
        }
        ... on TorConnection {
          origAddr
        }
        ... on TorConnectionConn {
          origAddr
        }
      }
    }
  }
`);
