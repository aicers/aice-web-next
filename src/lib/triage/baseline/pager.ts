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
 *       `baseline_version = PHASE_1B_BASELINE_VERSION`, `raw_score`,
 *       and `selector_tags` (§3 makes the menu's baseline score
 *       read-time-only — `cume_dist()` over `raw_score` per cohort —
 *       so no stored score column exists). Phase 2 stays at one
 *       batched SELECT plus one batched INSERT per page so the
 *       runner's per-page time budget does not get eaten by 500
 *       sequential statement executions.
 *
 * Steps (d)–(e) and the corpus-state UPDATE all commit in the per-page
 * transaction the runner already opens. The pager itself is purely
 * SQL + GraphQL; transaction scope, locking, and watermark UPDATE
 * live one level up in `runTriageBaselineCadence`.
 */

import type pg from "pg";

import type { ThreatCategory } from "@/lib/detection";
import { graphqlRequest } from "@/lib/graphql/client";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";
import {
  type ActiveExclusionSetResolver,
  computeExclusionsFingerprint,
  EMPTY_EXCLUSION_SET_RESOLVER,
  isExcluded,
  type NormalizedEventColumns,
  normalizeEventColumns,
} from "@/lib/triage/exclusion";
import {
  currentBaselineParameters,
  recordBaselineVersionSnapshot,
  recordExclusionSnapshot,
} from "@/lib/triage/snapshot";
import { runStepF } from "@/lib/triage/story/correlator";
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
 * declares.
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
    /**
     * The cadence path passes `{ customers: [...] }` only. The rebuild
     * path (#473) extends the filter with `start` / `end` to bound the
     * fetch to a specific `[from, to)` window. The `EventStandardFilterInput`
     * schema allows both fields to be NULL — see `schemas/review.graphql`
     * line 4004 — so this `Partial` union lets one shape carry both
     * callers without a separate query.
     */
    filter: {
      customers: string[];
      start?: string;
      end?: string;
    };
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
  // review-web's `Connection::pagination_input` validator rejects any
  // `first` outside `[0, 100]` with a GraphQL-level error
  // (`"The value of first and last must be within 0-100"`, #537), so
  // the cadence pager pins its default to the shared BFF cap. Tests
  // can still inject a smaller `pageSize` for deterministic per-page
  // behaviour.
  const pageSize = options.pageSize ?? REVIEW_MAX_PAGE_SIZE;
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

      const result = await processFetchedPage(client, customerId, response, {
        resolver,
        activeWindowsOverride,
        signal,
        runStoryCorrelator: true,
      });
      return result;
    },
  };
}

/**
 * Shared post-fetch pipeline (#473): normalize → exclusion → insert.
 *
 * Extracted from `createCadencePager` so the cadence path and the
 * admin rebuild path (#473) share the same code for steps (b)–(f).
 * The *fetch shape* differs between the two callers — cadence passes
 * cursor-only, rebuild passes `(start, end)` + cursor — but the
 * survivor-extraction, observed-meta INSERT, batch-scoring, and
 * baseline INSERT logic is byte-identical because both ingest from
 * the same `eventListWithTriage(triage = null)` resolver output.
 *
 * `runStoryCorrelator` controls step (f). Cadence always runs it.
 * The rebuild path turns it off because the story finalization
 * watermark is owned by cadence; re-running it for a historical
 * `[from, to)` window would either no-op (the watermark is already
 * ahead) or perversely re-finalize already-finalized stories.
 */
export async function processFetchedPage(
  client: pg.PoolClient,
  customerId: number,
  response: CadenceConnectionResponse,
  options: {
    resolver: ActiveExclusionSetResolver;
    activeWindowsOverride?: ActiveWindows;
    signal?: AbortSignal;
    runStoryCorrelator: boolean;
  },
): Promise<CadencePageResult> {
  const conn = response.eventListWithTriage;
  const edges = conn.edges;

  const active = await options.resolver.resolve(customerId);
  const exclusionsFp = computeExclusionsFingerprint(active.rules);

  // (b)–(d1) Normalize + filter + Blocklist* drop.
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

  // (#472) Snapshot the active exclusion set and the live baseline
  // tunables for `PHASE_1B_BASELINE_VERSION` before any
  // `baseline_triaged_event` / `observed_event_meta` row in this page
  // references them. Both writers UPSERT with `ON CONFLICT DO NOTHING`
  // so concurrent cadence pages collapse to a single canonical row per
  // fingerprint / version. The writes ride this page's transaction:
  // if a later step rolls back, the snapshot rolls back too, which is
  // fine because the same fingerprint will reappear on the next tick
  // and the writer is idempotent. `snapshotRows` is absent when the
  // resolver is the empty / test default; the payload then captures an
  // empty union, which is the correct audit answer for "no exclusions
  // active" — including for pre-#457 cadence runs.
  await recordExclusionSnapshot(
    client,
    exclusionsFp,
    active.snapshotRows ?? [],
  );
  await recordBaselineVersionSnapshot(
    client,
    PHASE_1B_BASELINE_VERSION,
    currentBaselineParameters(),
  );

  // (d2) Phase 1: stage every survivor into `observed_event_meta`.
  const observedResult = await insertObservedEventMetaBatch(client, survivors);
  const observedInserted = observedResult.rowCount ?? 0;

  // (e1) Active windows.
  const activeWindows =
    options.activeWindowsOverride ?? (await detectActiveWindows(client));

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

  // (e3)–(e4) INSERT into baseline_triaged_event.
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

  // (f) Story correlator — cadence-only. The rebuild path skips this
  // because the story finalization watermark is owned by cadence.
  if (options.runStoryCorrelator) {
    const pageEventTimeRange =
      baselineRows.length === 0
        ? null
        : computeEventTimeRange(baselineRows.map((r) => r.event.time));
    await runStepF({
      client,
      pageEventTimeRange,
      signal: options.signal,
    });
  }

  return {
    observedInserted,
    baselineInserted,
    endCursor: conn.pageInfo.endCursor,
    hasNextPage: conn.pageInfo.hasNextPage,
    exclusionsFp,
  };
}

/**
 * Production fetch helper exposed for the rebuild runner. Calls
 * `eventListWithTriage(triage = null)` with the cadence's system-actor
 * role and a customer-scoped filter, matching the cadence's outbound
 * call shape exactly except that the rebuild passes `start` / `end`
 * to bound the page set to a `[from, to)` window.
 */
export async function fetchEventPage(
  args: CadenceFetchPageArgs,
): Promise<CadenceConnectionResponse> {
  return defaultFetchPage(args);
}

export type { CadenceConnectionResponse };
export { REVIEW_MAX_PAGE_SIZE };

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

const BASELINE_COLS_PER_ROW = 18;

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
  // The menu's baseline score is read-time-only — RFC §3 computes it
  // via `cume_dist()` over `raw_score` per-`(kind, baseline_version)`
  // cohort at menu read — so the row persists only `raw_score` and
  // `selector_tags` (both NOT NULL).
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
        raw_score, selector_tags, payload_summary
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

function computeEventTimeRange(timestamps: ReadonlyArray<string>): {
  min: Date;
  max: Date;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const t of timestamps) {
    const ms = new Date(t).getTime();
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  return { min: new Date(min), max: new Date(max) };
}
