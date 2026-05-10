/**
 * Single GraphQL `EventTriageExclusionInput` parser (1B-1 / #481
 * deliverable §1).
 *
 * The vendored review-web SDL exposes one inline-exclusion shape used by
 * `eventListWithTriage` and (eventually) by the #457 storage CRUD path:
 *
 * ```graphql
 * input EventTriageExclusionInput {
 *   ipAddress: HostNetworkGroupInput   # nullable
 *   domain:    [String!]               # nullable
 *   hostname:  [String!]               # nullable
 *   uri:       [String!]               # nullable
 * }
 *
 * input HostNetworkGroupInput {
 *   hosts:    [String!]!
 *   networks: [String!]!
 *   ranges:   [IpRangeInput!]!
 * }
 * ```
 *
 * Everything that touches stored exclusions — the cadence runner here,
 * the corpus B runner (#460), the retroactive-DELETE planner / storage
 * CRUD (#457) — must convert that wire shape into the in-memory
 * {@link ExclusionRule} the matcher consumes. Centralising the
 * conversion in this module is what stops #457 from needing to redefine
 * the parser surface this issue is supposed to make shared.
 *
 * The parser:
 *   - rejects an exclusion object with no populated field (the resolver
 *     does the same — keeps the empty rule from silently filtering
 *     nothing while still producing fingerprint churn);
 *   - applies {@link validateDomainPattern} to every Domain pattern at
 *     the persistence boundary so cadence-time matching cannot diverge
 *     from review-web's Stage 1 matching on stored patterns;
 *   - drops unrelated extra fields rather than passing them through, so
 *     a future schema addition does not silently change exclusion
 *     semantics until this parser is updated.
 */

import { validateDomainPattern } from "./regex";
import type { ExclusionRule, IpAddressExclusionInput } from "./types";

export interface IpRangeInputShape {
  start: string;
  end: string;
}

export interface HostNetworkGroupInputShape {
  hosts?: string[] | null;
  networks?: string[] | null;
  ranges?: IpRangeInputShape[] | null;
}

export interface EventTriageExclusionInputShape {
  ipAddress?: HostNetworkGroupInputShape | null;
  domain?: string[] | null;
  hostname?: string[] | null;
  uri?: string[] | null;
}

export class ExclusionInputParseError extends Error {
  readonly index: number;

  constructor(message: string, index = -1) {
    super(message);
    this.name = "ExclusionInputParseError";
    this.index = index;
  }
}

/**
 * Parse a single `EventTriageExclusionInput`. Returns an
 * {@link ExclusionRule} with at least one populated field, or throws
 * {@link ExclusionInputParseError} for any of:
 *
 *   - empty / all-null input (the resolver requires at least one field
 *     populated; an empty rule is meaningless and would only churn the
 *     fingerprint);
 *   - any Domain pattern that fails {@link validateDomainPattern}
 *     (engine-divergent shorthand, lookbehind, etc.);
 *   - non-array Domain / Hostname / Uri lists.
 */
export function parseExclusionInput(
  input: EventTriageExclusionInputShape,
  index = -1,
): ExclusionRule {
  const rule: ExclusionRule = {};

  if (input.ipAddress !== null && input.ipAddress !== undefined) {
    rule.ipAddress = parseHostNetworkGroup(input.ipAddress, index);
  }

  if (input.domain !== null && input.domain !== undefined) {
    if (!Array.isArray(input.domain)) {
      throw new ExclusionInputParseError(
        formatError(index, "domain must be an array of strings"),
        index,
      );
    }
    const domain: string[] = [];
    for (const pattern of input.domain) {
      const result = validateDomainPattern(pattern);
      if (!result.ok) {
        throw new ExclusionInputParseError(
          formatError(
            index,
            `invalid domain pattern ${JSON.stringify(pattern)}: ${result.reason}`,
          ),
          index,
        );
      }
      domain.push(pattern);
    }
    if (domain.length > 0) rule.domain = domain;
  }

  if (input.hostname !== null && input.hostname !== undefined) {
    if (!Array.isArray(input.hostname)) {
      throw new ExclusionInputParseError(
        formatError(index, "hostname must be an array of strings"),
        index,
      );
    }
    const hostname = input.hostname.filter((s) => s.length > 0);
    if (hostname.length > 0) rule.hostname = hostname;
  }

  if (input.uri !== null && input.uri !== undefined) {
    if (!Array.isArray(input.uri)) {
      throw new ExclusionInputParseError(
        formatError(index, "uri must be an array of strings"),
        index,
      );
    }
    const uri = input.uri.filter((s) => s.length > 0);
    if (uri.length > 0) rule.uri = uri;
  }

  if (
    rule.ipAddress === undefined &&
    rule.domain === undefined &&
    rule.hostname === undefined &&
    rule.uri === undefined
  ) {
    throw new ExclusionInputParseError(
      formatError(
        index,
        "exclusion must have at least one populated field (ipAddress, domain, hostname, uri)",
      ),
      index,
    );
  }

  return rule;
}

/**
 * Parse a `[EventTriageExclusionInput!]` list (the shape carried by
 * `EventTriageInput.exclusions` and by the cadence "active set" resolver
 * once #457 wires real storage). Each element is parsed with
 * {@link parseExclusionInput}; the index of any failing element is
 * surfaced in the error message so storage CRUD can highlight the bad
 * row.
 */
export function parseExclusionInputs(
  inputs: EventTriageExclusionInputShape[] | null | undefined,
): ExclusionRule[] {
  if (inputs === null || inputs === undefined) return [];
  if (!Array.isArray(inputs)) {
    throw new ExclusionInputParseError(
      "exclusions must be an array of EventTriageExclusionInput",
    );
  }
  const rules: ExclusionRule[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    rules.push(parseExclusionInput(inputs[i], i));
  }
  return rules;
}

function parseHostNetworkGroup(
  group: HostNetworkGroupInputShape,
  index: number,
): IpAddressExclusionInput {
  const hosts = Array.isArray(group.hosts) ? group.hosts.slice() : [];
  const networks = Array.isArray(group.networks) ? group.networks.slice() : [];
  const ranges = Array.isArray(group.ranges)
    ? group.ranges.map((r) => ({ start: r.start, end: r.end }))
    : [];
  if (hosts.length === 0 && networks.length === 0 && ranges.length === 0) {
    throw new ExclusionInputParseError(
      formatError(
        index,
        "ipAddress must populate at least one of hosts / networks / ranges",
      ),
      index,
    );
  }
  return { hosts, networks, ranges };
}

function formatError(index: number, message: string): string {
  if (index < 0) return message;
  return `exclusions[${index}]: ${message}`;
}
