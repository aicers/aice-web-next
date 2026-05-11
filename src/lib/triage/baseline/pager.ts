import "server-only";

/**
 * Cadence pager (1B-1 / Phase 1.B — RFC 0001 §3, §7, §8).
 *
 * Two-phase per-page flow (extends #481's steps (d)–(e)). Both phases
 * run inside the same page transaction the runner already opens — the
 * "phase" labelling is scoring-stage, not transaction-boundary. If
 * Phase 2 fails the transaction rolls back, so `observed_event_meta` is
 * never left populated for rows whose `baseline_triaged_event` write
 * did not happen, and the page's `last_event_cursor` does not advance.
 *
 * Per page:
 *
 *   a. Fetch one raw standard-filter page from review via
 *      `eventListWithTriage(triage = null)`.
 *   b. Normalize each event into `host` / `dns_query` / `uri` per the
 *      shared helper's event-kind mapping (`src/lib/triage/exclusion/`).
 *   c. Apply the active exclusion set in-memory.
 *   d1. Drop `Blocklist*` events at the front — they are themselves a
 *       triage output (RFC §1). Excluding only at the baseline INSERT
 *       would leave them in `observed_event_meta` and pollute S1 / S3
 *       / S4 aggregates against the post-exclusion peer population.
 *
 *   Phase 1: Denominator INSERT (staging).
 *
 *   d2. One batched INSERT lifts all surviving (post-exclusion,
 *       post-Blocklist*) page events into `observed_event_meta` with
 *       `ON CONFLICT (event_key) DO NOTHING`. This places the page's
 *       own events into the denominator that Phase 2 reads — the
 *       S3 / S4 formulas account for self via their `- 1` terms (§3),
 *       and S1's `cume_dist()`-style percentile rank conventionally
 *       includes self.
 *
 *   Phase 2: Batch scoring + baseline INSERT.
 *
 *   e1. Detect which §7 statistics windows have wall-clock activation
 *       against the current `observed_event_meta` corpus.
 *   e2. Run one batched SELECT against `observed_event_meta` for the
 *       page rows: S1 percentile rank, S3 repeat count, S4 distinct
 *       categories — all three statistics windows packed into
 *       per-selector `FILTER` aggregates so the planner resolves the
 *       kind / time slice once per selector. See `selectors.ts`.
 *   e3. Per event, combine the per-window values via max (§7), apply
 *       §9 weights, add the per-event S2 + UNLABELED_BONUS
 *       contributions, emit `selector_tags` per §9 thresholds.
 *   e4. One batched INSERT lifts all page rows into
 *       `baseline_triaged_event` with
 *       `baseline_version = PHASE_1B_BASELINE_VERSION`,
 *       `raw_score`, `selector_tags`, and `baseline_score = NULL`
 *       (§3 makes `baseline_score` read-time-only; co-populating
 *       it with `raw_score` would falsely suggest a stored
 *       interpretation). Phase 2 stays at one batched SELECT plus
 *       one batched INSERT per page so the runner's per-page time
 *       budget does not get eaten by 500 sequential statement
 *       executions.
 *
 * Steps (d)–(e) and the corpus-state UPDATE all commit in the per-page
 * transaction the runner already opens. The pager itself is purely
 * SQL + GraphQL; transaction scope, locking, and watermark UPDATE
 * live one level up in `runTriageBaselineCadence`.
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
import type { TriageEvent } from "@/lib/triage/types";

import type { CadencePageResult, CadencePager } from "./cadence";
import { PHASE_1B_BASELINE_VERSION } from "./cadence";
import { EVENT_LIST_WITH_TRIAGE_QUERY } from "./queries";
import {
  type ActiveWindows,
  detectActiveWindows,
  type PageScoringRow,
  scoreEventFromBatch,
  scoreSelectorsForPage,
} from "./selectors";

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
 * `"Security Manager"` / `"Security Monitor"` (with the literal space).
 *
 * The cadence needs `System Administrator` because the per-customer
 * fetch carries the target customer in `filter.customers` and REview
 * deserializes the role first to decide whether the requester is
 * allowed to scope sensors that way at all.
 */
const CADENCE_ROLE = "System Administrator";

/**
 * Hard-exclusion prefix (RFC §1). Any event whose `__typename` starts
 * with this prefix is dropped before both corpus INSERTs. Matches the
 * `BlocklistBootp`, `BlocklistConn`, … typenames the REview schema
 * declares (the RFC text "BlockList*" is informal; the schema's
 * Pascal-case `Blocklist*` is what cadence actually sees on the wire).
 */
const BLOCKLIST_KIND_PREFIX = "Blocklist";

interface CadenceEventNode extends TriageEvent {
  // Re-asserted so tsc remembers the optional fields the cadence pager
  // actually consumes from the resolver response. The shape matches the
  // `EVENT_LIST_WITH_TRIAGE_QUERY` selection set.
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
  signal?: AbortSignal;
}

export interface CadencePagerOptions {
  fetchPage?: (
    args: CadenceFetchPageArgs,
  ) => Promise<CadenceConnectionResponse>;
  resolver?: ActiveExclusionSetResolver;
  pageSize?: number;
  /**
   * Test-only override of the §7 active-window detection. Skips the
   * `min(event_time)` probe so unit tests do not need a real
   * `observed_event_meta` corpus to exercise the per-window MAX path.
   */
  activeWindowsOverride?: ActiveWindows;
}

/**
 * Build the production cadence pager. The result is wired to
 * {@link runTriageBaselineCadence} so the runner stops returning
 * `pending` and starts populating both corpus tables under the
 * Phase 1.B four-selector scoring.
 */
export function createCadencePager(
  options: CadencePagerOptions = {},
): CadencePager {
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const resolver = options.resolver ?? EMPTY_EXCLUSION_SET_RESOLVER;
  const pageSize = options.pageSize ?? CADENCE_PAGE_SIZE;
  const activeWindowsOverride = options.activeWindowsOverride;

  return {
    async ingestPage(
      client: pg.PoolClient,
      customerId: number,
      afterCursor: string | null,
      signal?: AbortSignal,
    ): Promise<CadencePageResult> {
      // (a) Fetch raw standard-filter page from review.
      const response = await fetchPage({
        customerId,
        signal,
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

      // (b)–(d1) Normalize + filter + Blocklist* drop. The survivors
      // list is the input both phases operate on.
      const survivors: Array<{
        eventKey: string;
        event: CadenceEventNode;
        cols: NormalizedEventColumns;
      }> = [];
      for (const edge of edges) {
        const event = edge.node;
        if (event.__typename.startsWith(BLOCKLIST_KIND_PREFIX)) continue;
        const cols = normalizeEventColumns(event);
        if (isExcluded(cols, active)) continue;
        survivors.push({
          eventKey: cursorToEventKey(edge.cursor),
          event,
          cols,
        });
      }

      // (d2) Phase 1: stage every survivor into `observed_event_meta`
      // in one batched INSERT. Page rows must be in the denominator
      // before Phase 2 reads it — see the RFC's "S3 / S4 already
      // account for self via `- 1`" contract. ON CONFLICT keeps the
      // path idempotent against a re-run of the same page after a
      // Phase 2 failure. A single batched INSERT (vs. per-row) keeps
      // the Phase 1 round-trip count at O(1) per page so the cadence
      // runner's per-page time budget is not eaten by 500 sequential
      // statement executions.
      const observedResult = await insertObservedEventMetaBatch(
        client,
        survivors,
      );
      const observedInserted = observedResult.rowCount ?? 0;

      // (e1) Active windows: derived from observed_event_meta age
      // unless the caller injected an override (test paths).
      const activeWindows =
        activeWindowsOverride ?? (await detectActiveWindows(client));

      // (e2) Phase 2: batch-score the survivors against observed_event_meta.
      const pageRows: PageScoringRow[] = survivors.map(
        ({ eventKey, event, cols }) => ({
          eventKey,
          kind: event.__typename,
          origAddr: cols.origAddr,
          respAddr: cols.respAddr,
          category: event.category,
          confidence: readConfidence(event),
          clusterId: event.clusterId ?? null,
        }),
      );
      const selectorMap = await scoreSelectorsForPage(client, pageRows);

      // (e3)–(e4) INSERT into baseline_triaged_event. Every page row
      // is persisted (RFC §3 — `raw_score = 0` events still belong to
      // the corpus; the read-time menu filters on `baseline_score`
      // cutoffs, not on a stored INSERT gate). One batched INSERT per
      // page matches the issue's "single batched INSERT writes them"
      // contract and keeps Phase 2 at O(1) DB round-trips after the
      // batched selector SELECT.
      const baselineRows = survivors.map(({ eventKey, event, cols }) => {
        const outputs = scoreEventFromBatch(
          event,
          eventKey,
          cols.origAddr,
          cols.respAddr,
          selectorMap.get(eventKey),
          activeWindows,
        );
        return {
          eventKey,
          event,
          cols,
          rawScore: outputs.rawScore,
          selectorTags: outputs.selectorTags,
        };
      });
      const baselineResult = await insertBaselineTriagedEventBatch(
        client,
        baselineRows,
        exclusionsFp,
      );
      const baselineInserted = baselineResult.rowCount ?? 0;

      return {
        observedInserted,
        baselineInserted,
        endCursor: conn.pageInfo.endCursor,
        hasNextPage: conn.pageInfo.hasNextPage,
        exclusionsFp,
      };
    },
  };
}

async function defaultFetchPage(
  args: CadenceFetchPageArgs,
): Promise<CadenceConnectionResponse> {
  const context = {
    role: CADENCE_ROLE,
    customerIds: [args.customerId],
  };
  // biome-ignore format: keep the call on one line so the scope-allowlist
  // override sits on the same line as the graphqlRequest call.
  return graphqlRequest<CadenceConnectionResponse, typeof args.variables>(EVENT_LIST_WITH_TRIAGE_QUERY, args.variables, context, args.signal); // scope-allowlist: #481 system-actor cadence; customer scope materialised via JWT customer_ids + filter.customers
}

interface SurvivorRow {
  eventKey: string;
  event: CadenceEventNode;
  cols: NormalizedEventColumns;
}

interface BaselineRow extends SurvivorRow {
  rawScore: number;
  selectorTags: string[];
}

const BASELINE_COLS_PER_ROW = 19;

async function insertObservedEventMetaBatch(
  client: pg.PoolClient,
  rows: ReadonlyArray<SurvivorRow>,
): Promise<{ rowCount: number | null }> {
  if (rows.length === 0) return { rowCount: 0 };
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const { eventKey, event, cols } of rows) {
    const base = params.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
    );
    params.push(
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
      readConfidence(event),
    );
  }
  const result = await client.query(
    `INSERT INTO observed_event_meta (
        event_key, event_time, kind, category, sensor,
        orig_addr, resp_addr, host, dns_query, uri, confidence
      ) VALUES ${placeholders.join(", ")}
      ON CONFLICT (event_key) DO NOTHING`,
    params,
  );
  return { rowCount: result.rowCount };
}

async function insertBaselineTriagedEventBatch(
  client: pg.PoolClient,
  rows: ReadonlyArray<BaselineRow>,
  exclusionsFp: string,
): Promise<{ rowCount: number | null }> {
  if (rows.length === 0) return { rowCount: 0 };
  // Phase 1.B stops writing the legacy `baseline_score` column for new
  // rows — RFC §3 makes the value read-time-only (computed by
  // `cume_dist()` over `raw_score` per-`(kind, baseline_version)`
  // cohort at menu read). Co-populating it with `raw_score` would
  // suggest a stored interpretation that does not exist. `raw_score`
  // and `selector_tags` are the new persisted columns; PR 2's
  // migration sets both NOT NULL.
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const { eventKey, event, cols, rawScore, selectorTags } of rows) {
    const base = params.length;
    const ph: string[] = [];
    for (let i = 1; i <= BASELINE_COLS_PER_ROW; i += 1) {
      ph.push(`$${base + i}`);
    }
    placeholders.push(`(${ph.join(", ")})`);
    params.push(
      eventKey,
      event.time,
      event.__typename,
      event.sensor,
      cols.origAddr,
      event.origPort ?? null,
      cols.respAddr,
      event.respPort ?? null,
      null,
      cols.host,
      cols.dnsQuery,
      cols.uri,
      PHASE_1B_BASELINE_VERSION,
      exclusionsFp,
      categoryToDb(event.category),
      // Legacy baseline_score: NULL for Phase 1.B rows (RFC §3).
      null,
      rawScore,
      selectorTags,
      // payload_summary stays NULL — Phase 1.B does not surface
      // per-row payload extracts.
      null,
    );
  }
  const result = await client.query(
    `INSERT INTO baseline_triaged_event (
        event_key, event_time, kind, sensor,
        orig_addr, orig_port, resp_addr, resp_port, proto,
        host, dns_query, uri,
        baseline_version, exclusions_fp, category,
        baseline_score, raw_score, selector_tags, payload_summary
      ) VALUES ${placeholders.join(", ")}
      ON CONFLICT (event_key) DO NOTHING`,
    params,
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
