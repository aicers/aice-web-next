import { parse } from "graphql";

/**
 * GraphQL documents for the Detection event-query family.
 *
 * The documents below are validated against `schemas/review.graphql`
 * by `src/__tests__/lib/graphql/schema-validation.test.ts`, which
 * walks every inline `parse(...)` call in the repo. Keep them as
 * string literals so the AST walk can statically validate them.
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
        }
      }
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
      }
      totalCount
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
