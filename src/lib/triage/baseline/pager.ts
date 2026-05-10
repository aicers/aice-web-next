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
 * Role the cadence runner uses for outbound REview GraphQL. The cadence
 * is a system actor (no user session), so it carries the `admin` role
 * — same convention the Detection / Node-management scripts use.
 */
const CADENCE_DISPATCH_CONTEXT = { role: "admin" };

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
 * Decode a relay-style edge cursor into the review RocksDB i128 primary
 * key. The vendored review-web resolver encodes `event_key` as a
 * base64 string of the i128's big-endian byte representation (16
 * bytes); the cadence corpus tables store that integer in
 * `NUMERIC(39, 0)` PRIMARY KEY columns.
 *
 * If the cursor does not decode to exactly 16 bytes, the function
 * throws — the runner catches the error, marks the run `failed`, and
 * the watermark stays at the previous committed cursor. This is the
 * correct failure mode: silently coercing a malformed cursor into a
 * fallback PK value would risk mass collisions across event rows.
 */
export function cursorToEventKey(cursor: string): string {
  const bytes = Buffer.from(cursor, "base64");
  if (bytes.length !== 16) {
    throw new Error(
      `Cadence: unexpected cursor byte length ${bytes.length} (expected 16-byte i128 big-endian).`,
    );
  }
  let n = BigInt(0);
  const SHIFT_8 = BigInt(8);
  for (const byte of bytes) {
    n = (n << SHIFT_8) | BigInt(byte);
  }
  return n.toString();
}

export interface CadencePagerOptions {
  /**
   * Override the GraphQL fetch step. Tests inject a stub so the pager
   * can be unit-tested without hitting review-web.
   */
  fetchPage?: (variables: {
    filter: { customers: string[] };
    triage: null;
    first: number;
    after: string | null;
  }) => Promise<CadenceConnectionResponse>;
  /**
   * Active-exclusion-set resolver. Defaults to the empty-set resolver
   * (#457 swap point); tests inject a fake to drive the matcher.
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
        filter: { customers: [String(customerId)] },
        triage: null,
        first: pageSize,
        after: afterCursor,
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
      };
    },
  };
}

async function defaultFetchPage(variables: {
  filter: { customers: string[] };
  triage: null;
  first: number;
  after: string | null;
}): Promise<CadenceConnectionResponse> {
  // The cadence runs as a system actor (no user session) and
  // materialises customer scope through `filter.customers` sourced
  // from the route handler's `customer_id` parameter. There is no
  // session JWT to derive a `customerIds` list from, so the dispatch
  // context is the system-admin role.
  // biome-ignore format: keep the call on one line so the scope-allowlist
  // override sits on the same line as the graphqlRequest call.
  return graphqlRequest<CadenceConnectionResponse, typeof variables>(EVENT_LIST_WITH_TRIAGE_QUERY, variables, CADENCE_DISPATCH_CONTEXT); // scope-allowlist: #481 system-actor cadence; customer scope materialised via filter.customers
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
