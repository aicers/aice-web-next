import "server-only";

/**
 * Real `CadencePager` implementation (1B-1 / discussion #447 §3.4).
 *
 * Steps (a)–(e) of the per-page cadence pipeline:
 *
 *   a. Fetch one raw standard-filter page from review via
 *      `eventListWithTriage(triage = null, after = <last_event_cursor>,
 *      first = <page_size>)`.
 *   b. Normalize each event into `host` / `dns_query` / `uri` per the
 *      shared helper's event-kind mapping (`src/lib/triage/exclusion/`).
 *      NTLM stays NULL on host-like columns by design.
 *   c. Apply the active exclusion set in-memory (currently empty pre-#457;
 *      the helper's resolver returns `{ rules: [] }` so this is a
 *      pass-through until the storage adapter lands).
 *   d. INSERT remaining events into `observed_event_meta` with
 *      `ON CONFLICT (event_key) DO NOTHING`.
 *   e. INSERT the baseline-passing subset (`baselineScore > 0`) into
 *      `baseline_triaged_event` with the Phase 1.A markers
 *      (`PHASE_1A_BASELINE_VERSION`, `PHASE_1A_SELECTOR_TAG`, additive
 *      `baseline_score`, `exclusions_fp` from `computeExclusionsFingerprint`).
 *
 * Steps (d)–(e) and the corpus-state UPDATE all commit in the per-page
 * transaction the runner already opens. The pager itself is purely
 * SQL + GraphQL; transaction scope, locking, and watermark UPDATE live
 * one level up in `runTriageBaselineCadence`.
 */

import type pg from "pg";

import type { ThreatCategory } from "@/lib/detection";
import { graphqlRequest } from "@/lib/graphql/client";
import {
  type ActiveExclusionSetResolver,
  computeExclusionsFingerprint,
  EMPTY_EXCLUSION_SET_RESOLVER,
  isExcluded,
  type NormalizedEventColumns,
  normalizeEventColumns,
} from "@/lib/triage/exclusion";
import {
  baselineScore,
  hasUnlabeledBonus,
  PHASE_1A_UNLABELED_BONUS_TAG,
} from "@/lib/triage/scoring";
import type { TriageEvent } from "@/lib/triage/types";

import type { CadencePageResult, CadencePager } from "./cadence";
import { PHASE_1A_BASELINE_VERSION, PHASE_1A_SELECTOR_TAG } from "./cadence";
import { EVENT_LIST_WITH_TRIAGE_QUERY } from "./queries";

/**
 * Page size for `eventListWithTriage`. Large enough to amortize the
 * resolver round-trip cost over many INSERTs but bounded so a single
 * page transaction does not hold the connection too long.
 */
export const CADENCE_PAGE_SIZE = 500;

/**
 * Role the cadence runner uses for outbound REview GraphQL. The
 * cadence is a system actor (no user session). REview's Context-JWT
 * role enum names the built-in roles exactly as
 * `"System Administrator"` / `"Security Administrator"` /
 * `"Security Manager"` / `"Security Monitor"` (with the literal space)
 * — the legacy `"admin"` shorthand does not deserialize to any of
 * those, so requests carrying it are rejected before they hit the
 * field guard.
 *
 * The cadence needs `System Administrator` because the per-customer
 * fetch carries the target customer in `filter.customers` and REview
 * deserializes the role first to decide whether the requester is
 * allowed to scope sensors that way at all.
 */
const CADENCE_ROLE = "System Administrator";

interface CadenceEventNode extends TriageEvent {
  // Re-asserted here so tsc remembers the optional fields the cadence
  // pager actually consumes from the resolver response. The shape
  // matches the `EVENT_LIST_WITH_TRIAGE_QUERY` selection set.
}

interface CadenceEventEdge {
  cursor: string;
  node: CadenceEventNode;
}

interface CadenceConnectionResponse {
  eventListWithTriage: {
    pageInfo: {
      hasPreviousPage: boolean;
      hasNextPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    };
    edges: CadenceEventEdge[];
  };
}

/**
 * Validate a relay-style edge cursor and return the review RocksDB
 * primary key it carries.
 *
 * The vendored review-web resolver builds connection edges with
 * `Edge::new(k.to_string(), ev)` where `k` is the i128 RocksDB key —
 * so the wire cursor is just the decimal string of that integer (no
 * base64, no opaque wrapping). The cadence corpus tables store that
 * integer in `NUMERIC(39, 0)` PRIMARY KEY columns; we forward the
 * decimal string straight through.
 *
 * The validator rejects anything other than an unsigned decimal
 * literal of up to 39 digits (the unsigned-i128 range bound). A bad
 * cursor throws so the runner marks the page `failed` and leaves the
 * watermark at the previous committed cursor — silently coercing a
 * malformed cursor into a fallback PK would risk mass collisions
 * across event rows.
 */
const EVENT_KEY_PATTERN = /^[0-9]{1,39}$/;
export function cursorToEventKey(cursor: string): string {
  if (!EVENT_KEY_PATTERN.test(cursor)) {
    throw new Error(
      `Cadence: malformed edge cursor ${JSON.stringify(cursor)} (expected an unsigned decimal i128 string ≤ 39 digits).`,
    );
  }
  return cursor;
}

export interface CadenceFetchPageArgs {
  customerId: number;
  variables: {
    filter: { customers: string[] };
    triage: null;
    first: number;
    after: string | null;
  };
}

export interface CadencePagerOptions {
  /**
   * Override the GraphQL fetch step. Tests inject a stub so the pager
   * can be unit-tested without hitting review-web. The pager passes
   * `customerId` alongside the GraphQL variables so the production
   * fetcher can scope the outbound JWT's `customer_ids` to the same
   * customer the cadence is processing — REview rejects a system-actor
   * request that names a customer in `filter.customers` outside the
   * JWT scope.
   */
  fetchPage?: (
    args: CadenceFetchPageArgs,
  ) => Promise<CadenceConnectionResponse>;
  /**
   * Active-exclusion-set resolver. Defaults to the empty-set resolver,
   * but the production cadence route wires the storage-backed resolver
   * from `active-set-storage.ts` so stored exclusions (#457) take
   * effect on every tick. Tests inject a fake to drive the matcher.
   */
  resolver?: ActiveExclusionSetResolver;
  /**
   * Override the page size. Production code should use the default.
   */
  pageSize?: number;
}

/**
 * Build the production cadence pager. Caller is responsible for
 * passing the result to {@link runTriageBaselineCadence} so the runner
 * stops returning `pending` and starts populating both corpus tables.
 */
export function createCadencePager(
  options: CadencePagerOptions = {},
): CadencePager {
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const resolver = options.resolver ?? EMPTY_EXCLUSION_SET_RESOLVER;
  const pageSize = options.pageSize ?? CADENCE_PAGE_SIZE;

  return {
    async ingestPage(
      client: pg.PoolClient,
      customerId: number,
      afterCursor: string | null,
    ): Promise<CadencePageResult> {
      // (a) Fetch raw standard-filter page from review.
      const response = await fetchPage({
        customerId,
        variables: {
          filter: { customers: [String(customerId)] },
          triage: null,
          first: pageSize,
          after: afterCursor,
        },
      });
      const conn = response.eventListWithTriage;
      const edges = conn.edges;

      const active = await resolver.resolve(customerId);
      const exclusionsFp = computeExclusionsFingerprint(active.rules);

      let observedInserted = 0;
      let baselineInserted = 0;

      for (const edge of edges) {
        const event = edge.node;
        // (b) Normalize.
        const cols = normalizeEventColumns(event);
        // (c) Apply active exclusions.
        if (isExcluded(cols, active)) continue;

        const eventKey = cursorToEventKey(edge.cursor);

        // (d) INSERT into observed_event_meta.
        const observedResult = await insertObservedEventMeta(
          client,
          eventKey,
          event,
          cols,
        );
        observedInserted += observedResult.rowCount ?? 0;

        // (e) INSERT into baseline_triaged_event for the baseline-passing
        // subset.
        const score = baselineScore(event);
        if (score > 0) {
          const baselineResult = await insertBaselineTriagedEvent(
            client,
            eventKey,
            event,
            cols,
            score,
            exclusionsFp,
          );
          baselineInserted += baselineResult.rowCount ?? 0;
        }
      }

      return {
        observedInserted,
        baselineInserted,
        endCursor: conn.pageInfo.endCursor,
        hasNextPage: conn.pageInfo.hasNextPage,
        // Surface the page-level fingerprint so the runner can stamp
        // `baseline_corpus_state.exclusions_fp` with the same value the
        // per-row INSERTs carried. Otherwise the corpus-state row would
        // diverge from the per-row fingerprint as soon as #457 wires
        // real (non-empty) storage.
        exclusionsFp,
      };
    },
  };
}

async function defaultFetchPage(
  args: CadenceFetchPageArgs,
): Promise<CadenceConnectionResponse> {
  // The cadence runs as a system actor (no user session). The
  // outbound dispatch context names the `System Administrator` role
  // (REview's enum spelling — `"admin"` is not accepted) and
  // materialises the customer scope into the JWT's `customer_ids`
  // claim from the route handler's `customer_id` parameter. The same
  // value is also threaded into `filter.customers` so the resolver's
  // sensor scoping picks the right customer-tenant set.
  const context = {
    role: CADENCE_ROLE,
    customerIds: [args.customerId],
  };
  // biome-ignore format: keep the call on one line so the scope-allowlist
  // override sits on the same line as the graphqlRequest call.
  return graphqlRequest<CadenceConnectionResponse, typeof args.variables>(EVENT_LIST_WITH_TRIAGE_QUERY, args.variables, context); // scope-allowlist: #481 system-actor cadence; customer scope materialised via JWT customer_ids + filter.customers
}

async function insertObservedEventMeta(
  client: pg.PoolClient,
  eventKey: string,
  event: CadenceEventNode,
  cols: NormalizedEventColumns,
): Promise<{ rowCount: number | null }> {
  const result = await client.query(
    `INSERT INTO observed_event_meta (
        event_key, event_time, kind, category, sensor,
        orig_addr, resp_addr, host, dns_query, uri, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (event_key) DO NOTHING`,
    [
      eventKey,
      event.time,
      event.__typename,
      categoryToDb(event.category),
      event.sensor,
      cols.origAddr,
      cols.respAddr,
      cols.host,
      cols.dnsQuery,
      cols.uri,
      // `confidence` is on the Event interface (Float!) — used by 1B-8
      // for within-kind percentile ranking. Default to NULL when the
      // resolver omits it (defensive: the SDL declares it required).
      readConfidence(event),
    ],
  );
  return { rowCount: result.rowCount };
}

async function insertBaselineTriagedEvent(
  client: pg.PoolClient,
  eventKey: string,
  event: CadenceEventNode,
  cols: NormalizedEventColumns,
  score: number,
  exclusionsFp: string,
): Promise<{ rowCount: number | null }> {
  const tags = [PHASE_1A_SELECTOR_TAG];
  if (hasUnlabeledBonus(event)) tags.push(PHASE_1A_UNLABELED_BONUS_TAG);
  const result = await client.query(
    `INSERT INTO baseline_triaged_event (
        event_key, event_time, kind, sensor,
        orig_addr, orig_port, resp_addr, resp_port, proto,
        host, dns_query, uri,
        baseline_version, exclusions_fp, category,
        baseline_score, selector_tags, payload_summary
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18
      )
      ON CONFLICT (event_key) DO NOTHING`,
    [
      eventKey,
      event.time,
      event.__typename,
      event.sensor,
      cols.origAddr,
      event.origPort ?? null,
      cols.respAddr,
      event.respPort ?? null,
      // `proto` is not exposed on the Event interface — review-web
      // surfaces protocol kinds as the typename group itself. Leaving
      // NULL until/unless the resolver exposes a numeric proto field.
      null,
      cols.host,
      cols.dnsQuery,
      cols.uri,
      PHASE_1A_BASELINE_VERSION,
      exclusionsFp,
      categoryToDb(event.category),
      score,
      tags,
      // payload_summary stays NULL in Phase 1.A — 1B-8 will populate it
      // once selector evidence requires per-row payload extracts.
      null,
    ],
  );
  return { rowCount: result.rowCount };
}

function categoryToDb(category: ThreatCategory | null): string | null {
  if (category === null) return null;
  return category;
}

function readConfidence(event: CadenceEventNode): number | null {
  const value = (event as TriageEvent & { confidence?: number | null })
    .confidence;
  return typeof value === "number" ? value : null;
}
