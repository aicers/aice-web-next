/**
 * Detection types. Schema-derived types live in
 * `types.generated.ts` (produced by `pnpm codegen:detection` from
 * `schemas/review.graphql`). This file re-exports them and narrows
 * the pagination result shapes so `EventConnection.nodes` and
 * `EventEdge.node` carry the curated discriminated union over the
 * `Event` interface's subtypes instead of the raw `EventBase`.
 */

export type {
  DateTimeScalar,
  EndpointInput,
  EventBase,
  EventListFilterInput,
  FlowKind,
  HostNetworkGroupInput,
  IDScalar,
  IpRangeInput,
  LearningMethod,
  PageInfo,
  StringEventCounter,
  StringNumberScalar,
  ThreatCategory,
  ThreatLevel,
  ThreatLevelEventCounter,
  TrafficDirection,
  TriageScore,
  U8EventCounter,
} from "./types.generated";

import type {
  EventBase,
  EventConnection as GeneratedEventConnection,
  EventEdge as GeneratedEventEdge,
  StringEventCounter,
  ThreatLevelEventCounter,
  U8EventCounter,
} from "./types.generated";

/**
 * Curated list of `Event` interface subtypes the Detection result
 * list dispatches on. The list is a product choice — not every
 * implementor of the `Event` interface needs first-class UI handling
 * — but each entry must still be a real implementor in the vendored
 * `schemas/review.graphql`. That contract is enforced by
 * `src/__tests__/lib/detection/event-typenames.test.ts`, which fails
 * CI if a schema-pin bump renames or removes one of these types.
 *
 * Keep this list as a `readonly` tuple of string literals so the
 * `Event` union below inherits the literal `__typename` types.
 */
export const CURATED_EVENT_TYPENAMES = [
  "BlocklistBootp",
  "BlocklistConn",
  "BlocklistDceRpc",
  "BlocklistDhcp",
  "BlocklistDns",
  "BlocklistFtp",
  "BlocklistHttp",
  "BlocklistKerberos",
  "BlocklistLdap",
  "BlocklistMalformedDns",
  "BlocklistMqtt",
  "BlocklistNfs",
  "BlocklistNtlm",
  "BlocklistRadius",
  "BlocklistRdp",
  "BlocklistSmb",
  "BlocklistSmtp",
  "BlocklistSsh",
  "BlocklistTls",
  "CryptocurrencyMiningPool",
  "DnsCovertChannel",
  "DomainGenerationAlgorithm",
  "ExternalDdos",
  "ExtraThreat",
  "FtpBruteForce",
  "FtpPlainText",
  "HttpThreat",
  "LdapBruteForce",
  "LdapPlainText",
  "LockyRansomware",
  "MultiHostPortScan",
  "NetworkThreat",
  "NonBrowser",
  "PortScan",
  "RdpBruteForce",
  "RepeatedHttpSessions",
  "SuspiciousTlsTraffic",
  "TorConnection",
  "TorConnectionConn",
  "UnusualDestinationPattern",
  "WindowsThreat",
] as const;

export type CuratedEventTypename = (typeof CURATED_EVENT_TYPENAMES)[number];

/**
 * Narrowed discriminated union over the curated subset of `Event`
 * subtypes. Other subtypes still arrive at runtime (the `eventList`
 * query returns `Event!`) and fall back to the base shape via the
 * trailing `EventBase` member, so consumers always get at least the
 * common interface fields.
 */
export type Event =
  | {
      [K in CuratedEventTypename]: EventBase & { __typename: K };
    }[CuratedEventTypename]
  | EventBase;

/**
 * `EventConnection` / `EventEdge` narrowed so `nodes` and `node`
 * carry the `Event` discriminated union. The generated shapes in
 * `types.generated.ts` type these as `EventBase` because the SDL
 * only commits to the interface; the narrowing is a product choice
 * about which subtypes the UI dispatches on and lives here rather
 * than in the generated file.
 */
export interface EventEdge extends Omit<GeneratedEventEdge, "node"> {
  node: Event;
}

export interface EventConnection
  extends Omit<GeneratedEventConnection, "edges" | "nodes"> {
  edges: EventEdge[];
  nodes: Event[];
}

// ── Query result shapes ──────────────────────────────────────────
//
// These are the top-level shapes the server actions receive from
// `graphqlRequest`. They mirror each operation's selection set.

export interface EventListResult {
  eventList: EventConnection;
}

export interface EventDetailResult {
  event: Event | null;
}

/** Result shape from `ipLocation(address: IpAddress!): IpLocation`. */
export interface IpLocationResult {
  ipLocation: {
    latitude: number | null;
    longitude: number | null;
    country: string | null;
    region: string | null;
    city: string | null;
    isp: string | null;
    domain: string | null;
  } | null;
}

export interface EventCountsByCategoryResult {
  eventCountsByCategory: U8EventCounter;
}

export interface EventCountsByLevelResult {
  eventCountsByLevel: ThreatLevelEventCounter;
}

export interface EventCountsByCountryResult {
  eventCountsByCountry: StringEventCounter;
}

export interface EventCountsByKindResult {
  eventCountsByKind: StringEventCounter;
}

export interface EventCountsByIpAddressResult {
  eventCountsByIpAddress: StringEventCounter;
}

export interface EventCountsByOriginatorIpAddressResult {
  eventCountsByOriginatorIpAddress: StringEventCounter;
}

export interface EventCountsByResponderIpAddressResult {
  eventCountsByResponderIpAddress: StringEventCounter;
}

export interface EventFrequencySeriesResult {
  eventFrequencySeries: number[];
}
