import "server-only";

import { parse } from "graphql";

/**
 * Triage `eventList` query — Phase 1.A baseline (discussion #447 §3.2,
 * §3.3, §3.4).
 *
 * The selection includes the minimum the baseline scoring rule and
 * asset list need (interface fields plus `origAddr` and HttpThreat
 * `clusterId`) and the pivot-dimension fields enumerated in #476 §1
 * so #452 / #453 can do client-side pivot without re-fetching:
 *   - Network fields (`respAddr`, `origPort`, `respPort`,
 *     `origCountry`, `respCountry`, `origNetwork`, `respNetwork`) on
 *     every subtype that exposes them.
 *   - HTTP-shaped fields (`host`, `uri`, `userAgent`) on the four
 *     HTTP-shaped subtypes.
 *   - DNS-shaped fields (`query`, `answer`) on the four DNS-shaped
 *     subtypes (BlocklistMalformedDns is omitted — it carries only
 *     question/answer counts, no payload).
 *   - TLS-shaped fields (`ja3`, `ja3S`, `serverName`, `serial`,
 *     `subjectCommonName`) on the two TLS-shaped subtypes.
 *
 * `origNetwork` / `respNetwork` select the membership shape
 * (`HostNetworkGroup`) needed by the customer-network classifier so
 * the client side can answer "is this address inside the customer's
 * defined network?" without an extra round-trip.
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
      totalCount
      edges {
        cursor
      }
      nodes {
        __typename
        id
        time
        sensor
        category
        level
        ... on BlocklistBootp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistConn {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistDceRpc {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistDhcp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistDns {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          query
          answer
        }
        ... on BlocklistFtp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistHttp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          host
          uri
          userAgent
        }
        ... on BlocklistKerberos {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistLdap {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistMalformedDns {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistMqtt {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistNfs {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistNtlm {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistRadius {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistRdp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistSmb {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistSmtp {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistSsh {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on BlocklistTls {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          ja3
          ja3S
          serverName
          serial
          subjectCommonName
        }
        ... on CryptocurrencyMiningPool {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          query
          answer
        }
        ... on DnsCovertChannel {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          query
          answer
        }
        ... on DomainGenerationAlgorithm {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          host
          uri
          userAgent
        }
        ... on FtpBruteForce {
          origAddr
          respAddr
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on FtpPlainText {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on HttpThreat {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          clusterId
          host
          uri
          userAgent
        }
        ... on LdapBruteForce {
          origAddr
          respAddr
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on LdapPlainText {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on LockyRansomware {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          query
          answer
        }
        ... on MultiHostPortScan {
          origAddr
          respPort
          origCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on NetworkThreat {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on NonBrowser {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          host
          uri
          userAgent
        }
        ... on PortScan {
          origAddr
          respAddr
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on RdpBruteForce {
          origAddr
          origCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on RepeatedHttpSessions {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on SuspiciousTlsTraffic {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          ja3
          ja3S
          serverName
          serial
          subjectCommonName
        }
        ... on TorConnection {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
        ... on TorConnectionConn {
          origAddr
          respAddr
          origPort
          respPort
          origCountry
          respCountry
          origNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
          respNetwork {
            networks {
              hosts
              networks
              ranges { start end }
            }
          }
        }
      }
    }
  }
`);
