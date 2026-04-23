import { parse } from "graphql";

/**
 * GraphQL documents for the Detection event-query family.
 *
 * The documents below are validated against `schemas/review.graphql`
 * by `src/__tests__/lib/graphql/schema-validation.test.ts`, which
 * walks every inline `parse(...)` call in the repo. Keep them as
 * string literals so the AST walk can statically validate them.
 */

/**
 * `eventList` selection set for the Detection result list (Phase
 * Detection-9). The list view renders a two-line entry per event:
 * row 1 = severity / time / kind / confidence / triage summary
 * (covered by the common `Event` interface fields); row 2 =
 * `source endpoint → destination endpoint` + sensor.
 *
 * The interface only commits to the row-1 fields, so the addressing
 * data (`origAddr`, ports, country, plus `attackKind` for the four
 * ML subtypes) is selected per curated subtype via inline fragments.
 * Subtypes outside the inline-fragment set still arrive — the row
 * renderer falls back to "—" addressing rather than dropping them.
 *
 * Several subtypes cannot render a full `source IP:port → destination
 * IP:port` pair because the REview schema simply does not expose the
 * missing fields. The row renderer degrades gracefully per subtype
 * rather than dropping the row; these are the documented exceptions
 * to #280's "every subtype shows source/destination IP+port" rule:
 *   - `ExtraThreat` (schemas/review.graphql:3975) and `WindowsThreat`
 *     (schemas/review.graphql:8104) are host-based process /
 *     pattern events — `attackKind`, `image`, `user`, `processGuid`,
 *     etc., with no `origAddr` / `respAddr`. Both endpoints render
 *     `—` and the Investigation affordance is hidden because the
 *     locator token cannot be built.
 *   - `ExternalDdos` (schemas/review.graphql:3865) exposes
 *     `origAddrs` / `respAddr` + countries but no ports on either
 *     side. The row renders IPs + countries with no `:port` suffix.
 *   - `FtpBruteForce` (schemas/review.graphql:4043) and
 *     `LdapBruteForce` (schemas/review.graphql:4640) expose
 *     `respPort` but no `origPort`. The source cell is rendered
 *     without a port suffix; the destination cell keeps its port.
 *   - `RdpBruteForce` (schemas/review.graphql:6697) exposes `origAddr`
 *     (with no `origPort`) and `respAddrs` but no `respPort` / per-
 *     responder port list. The destination cell has no port suffix.
 *   - `UnusualDestinationPattern` (schemas/review.graphql:8015)
 *     exposes no originator — only `respAddrs` / `respCountries`.
 *     The source cell renders `—`, the destination renders IPs +
 *     countries, and the Investigation affordance is hidden
 *     (`isEventAddressable` requires an originator).
 *
 * This selection deliberately stays narrower than `EVENT_DETAIL_QUERY`:
 * payload bodies, durations, packet counts, and other detail-only
 * fields are not on the list and would only inflate the response.
 */
export const EVENT_LIST_QUERY = parse(`
  query EventList(
    $filter: EventListFilterInput!
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    eventList(
      filter: $filter
      first: $first
      after: $after
      last: $last
      before: $before
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
          ...EventListNode
        }
      }
      totalCount
    }
  }

  fragment EventListNode on Event {
    __typename
    time
    sensor
    confidence
    category
    level
    triageScores {
      policyId
      score
    }
    ... on BlocklistBootp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistConn {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistDceRpc {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistDhcp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistDns {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistFtp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistHttp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistKerberos {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistLdap {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistMalformedDns {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistMqtt {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistNfs {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistNtlm {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistRadius {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistRdp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistSmb {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistSmtp {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistSsh {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on BlocklistTls {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on CryptocurrencyMiningPool {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on DnsCovertChannel {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on DomainGenerationAlgorithm {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on ExternalDdos {
      origAddrs
      origCountries
      respAddr
      respCountry
      proto
    }
    ... on ExtraThreat {
      attackKind
    }
    ... on FtpBruteForce {
      origAddr
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on FtpPlainText {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on HttpThreat {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
      attackKind
    }
    ... on LdapBruteForce {
      origAddr
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on LdapPlainText {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on LockyRansomware {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on UnusualDestinationPattern {
      respAddrs
      respCountries
    }
    ... on MultiHostPortScan {
      origAddr
      origCountry
      respAddrs
      respCountries
      respPort
      proto
    }
    ... on NetworkThreat {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
      attackKind
    }
    ... on NonBrowser {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on PortScan {
      origAddr
      origCountry
      respAddr
      respCountry
      respPorts
      proto
    }
    ... on RdpBruteForce {
      origAddr
      origCountry
      respAddrs
      respCountries
      proto
    }
    ... on RepeatedHttpSessions {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on SuspiciousTlsTraffic {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on TorConnection {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on TorConnectionConn {
      origAddr
      origPort
      origCountry
      respAddr
      respPort
      respCountry
      proto
    }
    ... on WindowsThreat {
      attackKind
    }
  }
`);

// ── Event detail (investigation view) ──────────────────────────
//
// The investigation page at `/events/<token>` decodes a composite
// locator (see `@/lib/events/event-locator`) into a tight filter
// and reuses `eventList` for lookup. The selection set below is a
// superset of the list-view selection — it adds the addressing
// fields (`origAddr`, `respAddr`, ports, proto, customer, network)
// plus inline fragments for the curated `Event` subtypes so the
// Protocol tab can render kind-specific content without a second
// round-trip.
//
// Subtypes absent from the inline-fragment set still render via
// the Overview / Endpoints tabs (they receive the common `Event`
// interface fields plus the addressing fields from the
// `EventWithAddressing` fragment).
export const EVENT_DETAIL_QUERY = parse(`
  query EventDetail($filter: EventListFilterInput!) {
    eventList(filter: $filter, first: 5) {
      totalCount
      nodes {
        __typename
        time
        sensor
        confidence
        category
        level
        triageScores {
          policyId
          score
        }
        ... on BlocklistConn {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          connState
          service
          startTime
          duration
          origBytes
          respBytes
          origPkts
          respPkts
        }
        ... on DnsCovertChannel {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          duration
          query
          answer
          transId
          rtt
          qclass
          qtype
          rcode
          aaFlag
          tcFlag
          rdFlag
          raFlag
          ttl
        }
        ... on FtpBruteForce {
          origAddr
          origCountry
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          userList
          startTime
          endTime
          isInternal
        }
        ... on HttpThreat {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          duration
          method
          host
          uri
          referer
          version
          userAgent
          requestLen
          responseLen
          statusCode
          statusMsg
          username
          password
          cookie
          contentEncoding
          contentType
          cacheControl
          filenames
          mimeTypes
          body
          content
          state
          attackKind
        }
        ... on NetworkThreat {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          duration
          service
          content
          attackKind
        }
        ... on PortScan {
          origAddr
          origCountry
          respAddr
          respCountry
          respPorts
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          endTime
        }
        ... on MultiHostPortScan {
          origAddr
          origCountry
          respAddrs
          respCountries
          respPort
          proto
          origCustomer { id name }
          respCustomers { id name }
          respNetwork { id name }
          startTime
          endTime
        }
        ... on FtpPlainText {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          duration
          user
          password
          commands {
            command
            replyCode
            replyMsg
          }
        }
        ... on BlocklistDns {
          origAddr
          origCountry
          origPort
          respAddr
          respCountry
          respPort
          proto
          origCustomer { id name }
          respCustomer { id name }
          origNetwork { id name }
          respNetwork { id name }
          startTime
          duration
          query
          answer
          transId
          rtt
          qclass
          qtype
          rcode
          aaFlag
          tcFlag
          rdFlag
          raFlag
          ttl
        }
        ... on RdpBruteForce {
          origAddr
          origCountry
          respAddrs
          respCountries
          proto
          origCustomer { id name }
          origNetwork { id name }
          respCustomers { id name }
          startTime
          endTime
        }
        ... on ExternalDdos {
          origAddrs
          origCountries
          respAddr
          respCountry
          proto
          origCustomers { id name }
          origNetwork { id name }
          respCustomer { id name }
          respNetwork { id name }
          startTime
          endTime
        }
      }
    }
  }
`);

export const IP_LOCATION_QUERY = parse(`
  query IpLocationLookup($address: IpAddress!) {
    ipLocation(address: $address) {
      latitude
      longitude
      country
      region
      city
      isp
      domain
    }
  }
`);

export const EVENT_COUNTS_BY_CATEGORY_QUERY = parse(`
  query EventCountsByCategory($filter: EventListFilterInput!, $first: Int!) {
    eventCountsByCategory(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_LEVEL_QUERY = parse(`
  query EventCountsByLevel($filter: EventListFilterInput!, $first: Int!) {
    eventCountsByLevel(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_COUNTRY_QUERY = parse(`
  query EventCountsByCountry($filter: EventListFilterInput!, $first: Int!) {
    eventCountsByCountry(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_KIND_QUERY = parse(`
  query EventCountsByKind($filter: EventListFilterInput!, $first: Int!) {
    eventCountsByKind(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_IP_ADDRESS_QUERY = parse(`
  query EventCountsByIpAddress($filter: EventListFilterInput!, $first: Int!) {
    eventCountsByIpAddress(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_ORIGINATOR_IP_ADDRESS_QUERY = parse(`
  query EventCountsByOriginatorIpAddress(
    $filter: EventListFilterInput!
    $first: Int!
  ) {
    eventCountsByOriginatorIpAddress(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_COUNTS_BY_RESPONDER_IP_ADDRESS_QUERY = parse(`
  query EventCountsByResponderIpAddress(
    $filter: EventListFilterInput!
    $first: Int!
  ) {
    eventCountsByResponderIpAddress(filter: $filter, first: $first) {
      values
      counts
    }
  }
`);

export const EVENT_FREQUENCY_SERIES_QUERY = parse(`
  query EventFrequencySeries($filter: EventListFilterInput!, $period: Int!) {
    eventFrequencySeries(filter: $filter, period: $period)
  }
`);
