import { parse } from "graphql";

/**
 * GraphQL documents for the Detection event-query family.
 *
 * The documents below are validated against `schemas/review.graphql`
 * by `src/__tests__/lib/graphql/schema-validation.test.ts`, which
 * walks every inline `parse(...)` call in the repo. Keep them as
 * string literals so the AST walk can statically validate them.
 */

// Per-typename inline fragments select the addressing/network fields
// the result-list rows render (Phase Detection-9) plus the small set
// of protocol highlight fields Quick peek (Phase Detection-18) shows
// at a glance. The selection stays minimal — a handful of fields per
// subtype rather than the full payload the investigation view needs.
// Heavy payload fields (HTTP body, DNS answer list, FTP commands,
// etc.) live in EVENT_DETAIL_QUERY and are not requested here.
//
// Subtypes that surface a Username or Host/Hostname per the schema
// also select those fields here so the result row can render the
// Phase Detection-28 identity columns (issue #347): the row reads
// `username` (HTTP-class threats, BlocklistNtlm), the camelCase
// `userName` field (BlocklistRadius), or the documented-as-
// Username `user` field (BlocklistFtp / FtpPlainText / WindowsThreat)
// into the userName cell, and `host` / `hostname` into the hostname
// cell. Subtypes that do not emit either field render the cell as
// a non-pivotable `—` token; the column position stays stable so
// the operator can tell that the row simply has no identity to
// pivot on.
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
          __typename
          id
          time
          sensor
          confidence
          category
          level
          triageScores {
            policyId
            score
          }
        }
      }
      nodes {
        __typename
        id
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
          query
          qtype
          rcode
        }
        ... on BlocklistFtp {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          user
        }
        ... on BlocklistHttp {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          method
          host
          uri
          statusCode
          learningMethod
          username
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
          username
          hostname
        }
        ... on BlocklistRadius {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          userName
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
          serverName
          version
          ja3
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
          query
          qtype
          rcode
          learningMethod
        }
        ... on DomainGenerationAlgorithm {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          learningMethod
          host
          username
        }
        ... on ExternalDdos {
          origAddrs
          origCountries
          respAddr
          respCountry
          proto
          startTime
          endTime
        }
        ... on ExtraThreat {
          attackKind
          learningMethod
        }
        ... on FtpBruteForce {
          origAddr
          origCountry
          respAddr
          respCountry
          respPort
          proto
          userList
          startTime
          endTime
          isInternal
        }
        ... on FtpPlainText {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          user
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
          method
          host
          uri
          statusCode
          learningMethod
          username
        }
        ... on LdapBruteForce {
          origAddr
          origCountry
          respAddr
          respCountry
          respPort
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
        ... on MultiHostPortScan {
          origAddr
          origCountry
          respAddrs
          respCountries
          respPort
          proto
          startTime
          endTime
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
          service
          learningMethod
        }
        ... on NonBrowser {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          learningMethod
          host
          username
        }
        ... on PortScan {
          origAddr
          origCountry
          respAddr
          respCountry
          respPorts
          proto
          startTime
          endTime
        }
        ... on RdpBruteForce {
          origAddr
          origCountry
          respAddrs
          respCountries
          proto
          startTime
          endTime
        }
        ... on RepeatedHttpSessions {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          learningMethod
        }
        ... on SuspiciousTlsTraffic {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          serverName
          version
          ja3
        }
        ... on TorConnection {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          learningMethod
          host
          username
        }
        ... on TorConnectionConn {
          origAddr
          origPort
          origCountry
          respAddr
          respPort
          respCountry
          proto
          learningMethod
        }
        ... on UnusualDestinationPattern {
          respAddrs
          respCountries
          learningMethod
        }
        ... on WindowsThreat {
          attackKind
          learningMethod
          user
        }
      }
      totalCount
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
        id
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
