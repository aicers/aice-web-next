import "server-only";

/**
 * Corpus B on-demand runner (1B-6 / discussion #447 §3.4-3.5).
 *
 * Orchestrates one user-triggered "With my policies" run:
 *
 *   1. Claim the active fingerprint slot — either by INSERTing a fresh
 *      `computing` row or by superseding an existing `ready` row in a
 *      recompute transaction.
 *   2. Page through `eventListWithTriage` with `triage` populated (the
 *      caller's policies plus the active global+customer-scoped
 *      exclusion set), persisting matching events into
 *      `policy_triaged_event`.
 *   3. Re-apply the same active exclusion set in-memory against the
 *      normalized columns BEFORE INSERT — this is the app-side
 *      fallback that closes the TLS / NTLM gap from
 *      review-database#723. Until #723 lands, this is load-bearing for
 *      TLS Domain/Hostname exclusions; after #723 it is still correct,
 *      just no longer the only enforcement.
 *   4. Mark the run `ready` and record duration. Encoding errors,
 *      transport errors, etc. transition the run to `failed` with a
 *      structured `last_error` — never an unhandled panic.
 *
 * The runner is intentionally independent of the menu read-path: the
 * caller (API route) hands it a snapshot of the policies + period, and
 * the runner does not consult the menu's display logic. The
 * "deprecatability seam" rule in §6 keeps this file inside
 * `triage/policy/corpus-b/` so removing the policy mode removes the
 * runner; the shared exclusion / inline-policy helpers stay in place.
 */

import { graphqlRequest } from "@/lib/graphql/client";
import {
  type ActiveExclusionSet,
  type ActiveExclusionSetResolver,
  computeExclusionsFingerprint,
  type ExclusionRule,
  isExcluded,
  normalizeEventColumns,
  STORAGE_EXCLUSION_SET_RESOLVER,
} from "@/lib/triage/exclusion";
import { InlinePolicyEncodingError } from "@/lib/triage/inline-policy";
import type { TriageEvent } from "@/lib/triage/types";

import { getCustomerPool } from "../customer-db";
import {
  type EncodedEventTriagePolicyInput,
  translatePolicyToInlineInput,
} from "../inline-translator";
import type { TriagePolicyRow } from "../types";

import { computePoliciesFingerprint } from "./fingerprint";
import { CORPUS_B_EVENT_LIST_QUERY } from "./queries";
import {
  findActiveRun,
  getRunById,
  insertComputingRun,
  insertTriagedEventsBatch,
  markRunFailed,
  markRunReadyOnClient,
  PolicyTriageRunActiveSlotConflict,
  recomputeRun,
} from "./repository";
import type { PolicyTriagedEventRow, PolicyTriageRunRow } from "./types";

/**
 * Phase 1.B baseline-version marker. Mirrors the cadence's marker so
 * a corpus B run for a window where corpus A is in the same algorithm
 * version reads from the same baseline_version cohort.
 */
export { PHASE_1B_BASELINE_VERSION as CORPUS_B_BASELINE_VERSION } from "@/lib/triage/baseline/cadence";

/**
 * Per-page fetch size. The corpus B window is bounded by the menu cap
 * (30 days; see #447 §3.2), so a single run typically completes in a
 * handful of pages.
 */
export const CORPUS_B_PAGE_SIZE = 500;

/**
 * Hard cap on pages per run. Defends against a runaway resolver
 * `hasNextPage = true` loop.
 */
const MAX_PAGES_PER_RUN = 200;

const CORPUS_B_ROLE = "System Administrator";

export interface CorpusBRunRequest {
  customerId: number;
  ownerAccountId: string;
  periodStartIso: string;
  periodEndIso: string;
  policies: ReadonlyArray<TriagePolicyRow>;
  baselineVersion: string;
  /** Why this run was started. `null` for a fresh run; `"selection-conditions-changed"` for a recompute. */
  refreshReason: string | null;
  signal?: AbortSignal;
}

export interface CorpusBRunResult {
  /** Final run row (status = `ready`, `failed`, or `superseded` if a race lost). */
  run: PolicyTriageRunRow;
  /** Number of rows persisted into `policy_triaged_event`. */
  insertedEventCount: number;
  /** `true` when the run was reused from a previous `ready` row in the same fingerprint slot. */
  reusedCache: boolean;
}

/**
 * Encoded inline `EventTriageInput.exclusions`. Used by the corpus B
 * runner to forward the active exclusion set to the resolver's
 * Stage 1 pre-cut.
 */
function exclusionsForResolver(rules: ReadonlyArray<ExclusionRule>): unknown[] {
  // The resolver's `EventTriageExclusionInput` is one rule per object;
  // a single rule carrying multiple populated fields is flattened to
  // independent `TriageExclusion` values, so passing one rule per
  // populated field is symmetric.
  const out: unknown[] = [];
  for (const rule of rules) {
    const r: Record<string, unknown> = {};
    if (rule.ipAddress) r.ipAddress = rule.ipAddress;
    if (rule.domain && rule.domain.length > 0) r.domain = rule.domain;
    if (rule.hostname && rule.hostname.length > 0) r.hostname = rule.hostname;
    if (rule.uri && rule.uri.length > 0) r.uri = rule.uri;
    if (Object.keys(r).length > 0) out.push(r);
  }
  return out;
}

type CorpusBFetchVariables = {
  filter: {
    start: string;
    end: string;
    customers: string[];
  };
  triage: {
    policies: EncodedEventTriagePolicyInput[];
    exclusions: unknown[];
  };
  first: number;
  after: string | null;
} & Record<string, unknown>;

interface ResolverEventNode extends TriageEvent {
  __typename: string;
  triageScores?: { policyId: string; score: number }[] | null;
}

interface ResolverEdge {
  cursor: string;
  node: ResolverEventNode;
}

interface ResolverPage {
  eventListWithTriage: {
    pageInfo: {
      hasPreviousPage: boolean;
      hasNextPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    };
    edges: ResolverEdge[];
  };
}

export interface CorpusBRunnerOptions {
  /** Override the default storage-backed exclusion resolver (tests). */
  exclusionResolver?: ActiveExclusionSetResolver;
  /** Override the default GraphQL fetch (tests). */
  fetchPage?: (
    variables: CorpusBFetchVariables,
    signal?: AbortSignal,
  ) => Promise<ResolverPage>;
  /** Override the per-page size (tests). */
  pageSize?: number;
}

/**
 * The principal entry point. Returns the final run row plus the count
 * of inserted `policy_triaged_event` rows. The caller (API route)
 * decides how to surface "reused cache" vs "fresh run" to the user.
 *
 * Errors are wrapped: any throw inside the page loop transitions the
 * `computing` row to `failed` (with `last_error`) and returns the
 * resulting row. The function itself only throws when the slot-
 * conflict re-query fails — i.e. a malformed input that cannot find
 * its own active slot — which is an internal-server-error condition
 * for the route handler.
 */
export async function runCorpusBTriage(
  request: CorpusBRunRequest,
  options: CorpusBRunnerOptions = {},
): Promise<CorpusBRunResult> {
  const exclusionResolver =
    options.exclusionResolver ?? STORAGE_EXCLUSION_SET_RESOLVER;
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const pageSize = options.pageSize ?? CORPUS_B_PAGE_SIZE;
  const startedAt = Date.now();

  // Fingerprinting does not depend on byte encoding, so the slot can
  // be claimed before policies are encoded. Encoding happens inside
  // `runInsideClaimedSlot` so an `InlinePolicyEncodingError` flows
  // through the same `markRunFailed` path as fetch / DB errors —
  // every failure mode ends up as a real `status='failed'` row with
  // `last_error` populated, never a synthesised pseudo-row.
  const policiesFingerprint = computePoliciesFingerprint(request.policies);
  const active = await exclusionResolver.resolve(request.customerId);
  const exclusionsFingerprint = computeExclusionsFingerprint(active.rules);

  const lookup = {
    ownerAccountId: request.ownerAccountId,
    periodStartIso: request.periodStartIso,
    periodEndIso: request.periodEndIso,
    policiesFingerprint,
    exclusionsFingerprint,
    baselineVersion: request.baselineVersion,
  };

  // Active-slot lookup. A `ready` row is returned as a cache hit;
  // a `computing` row means another runner is mid-flight — also
  // returned, the caller can poll. Either way no new row is created.
  const existing = await findActiveRun(request.customerId, lookup);
  if (existing) {
    return { run: existing, insertedEventCount: 0, reusedCache: true };
  }

  // Claim the slot. The recompute path is the caller's responsibility:
  // if the caller already knows a `ready` row exists with a stale
  // fingerprint and the user clicked "Recompute", the caller invokes
  // {@link recomputeCorpusBRun}. The non-recompute path here only ever
  // INSERTs a fresh row.
  let run: PolicyTriageRunRow;
  try {
    run = await insertComputingRun(request.customerId, {
      ...lookup,
      refreshReason: request.refreshReason,
    });
  } catch (err) {
    if (err instanceof PolicyTriageRunActiveSlotConflict) {
      // Race: someone created the active row between findActiveRun
      // and insertComputingRun. Re-query the slot and treat as cache.
      const after = await findActiveRun(request.customerId, lookup);
      if (after) {
        return { run: after, insertedEventCount: 0, reusedCache: true };
      }
    }
    throw err;
  }

  return runInsideClaimedSlot({
    request,
    run,
    active,
    fetchPage,
    pageSize,
    startedAt,
  });
}

/**
 * Recompute helper for the common "user clicked Recompute on a stale
 * `ready` row" flow. Pre-allocates the new id, supersedes the old
 * row, INSERTs the new one, then runs the same page loop.
 */
export async function recomputeCorpusBRun(
  oldRunId: string,
  request: CorpusBRunRequest,
  options: CorpusBRunnerOptions = {},
): Promise<CorpusBRunResult> {
  const exclusionResolver =
    options.exclusionResolver ?? STORAGE_EXCLUSION_SET_RESOLVER;
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const pageSize = options.pageSize ?? CORPUS_B_PAGE_SIZE;
  const startedAt = Date.now();

  const policiesFingerprint = computePoliciesFingerprint(request.policies);
  const active = await exclusionResolver.resolve(request.customerId);
  const exclusionsFingerprint = computeExclusionsFingerprint(active.rules);

  let run: PolicyTriageRunRow;
  try {
    run = await recomputeRun(request.customerId, {
      ownerAccountId: request.ownerAccountId,
      periodStartIso: request.periodStartIso,
      periodEndIso: request.periodEndIso,
      policiesFingerprint,
      exclusionsFingerprint,
      baselineVersion: request.baselineVersion,
      refreshReason: request.refreshReason ?? "selection-conditions-changed",
      oldRunId,
    });
  } catch (err) {
    if (err instanceof PolicyTriageRunActiveSlotConflict) {
      // Either the old row was already superseded / reaped, or a
      // concurrent recompute won the race. Re-query the active slot
      // to surface whichever row is now there.
      const after = await findActiveRun(request.customerId, {
        ownerAccountId: request.ownerAccountId,
        periodStartIso: request.periodStartIso,
        periodEndIso: request.periodEndIso,
        policiesFingerprint,
        exclusionsFingerprint,
        baselineVersion: request.baselineVersion,
      });
      if (after) {
        return { run: after, insertedEventCount: 0, reusedCache: true };
      }
    }
    throw err;
  }

  return runInsideClaimedSlot({
    request,
    run,
    active,
    fetchPage,
    pageSize,
    startedAt,
  });
}

interface ClaimedSlotArgs {
  request: CorpusBRunRequest;
  run: PolicyTriageRunRow;
  active: ActiveExclusionSet;
  fetchPage: (
    variables: CorpusBFetchVariables,
    signal?: AbortSignal,
  ) => Promise<ResolverPage>;
  pageSize: number;
  startedAt: number;
}

/**
 * Raised when the per-run page cap fires while the resolver still
 * reports `hasNextPage = true`. Surfaced as a structured run failure
 * so a truncated run is never silently materialised as `ready`.
 */
class CorpusBPageCapExceededError extends Error {
  constructor(maxPages: number) {
    super(
      `Corpus B: page cap of ${maxPages} reached with more pages still available; run truncated and marked failed`,
    );
    this.name = "CorpusBPageCapExceededError";
  }
}

/**
 * Raised when the resolver returns `hasNextPage = true` but
 * `endCursor = null`. Without an `endCursor` the runner cannot
 * continue paging, so this is the same user-visible failure mode as
 * the page cap: the run is incomplete and must not silently
 * materialise as `ready`.
 */
class CorpusBMalformedPaginationError extends Error {
  constructor() {
    super(
      "Corpus B: resolver returned hasNextPage=true with endCursor=null; cannot continue paging, run marked failed",
    );
    this.name = "CorpusBMalformedPaginationError";
  }
}

/**
 * Raised when the `computing → ready` UPDATE finds zero rows — meaning
 * the run was already transitioned to a terminal status (`failed` by
 * 1B-7's reaper, `superseded` by a concurrent recompute) before this
 * runner reached the ready flip. The transaction is rolled back so the
 * already-inserted events do not get committed under a stale run id;
 * the runner re-reads the current row and returns it as-is rather than
 * reviving a terminal row.
 */
class CorpusBRunSlotLostError extends Error {
  constructor() {
    super(
      "Corpus B: run row was no longer in 'computing' state at the ready flip; another transition has already terminalised it",
    );
    this.name = "CorpusBRunSlotLostError";
  }
}

async function runInsideClaimedSlot(
  args: ClaimedSlotArgs,
): Promise<CorpusBRunResult> {
  const { request, run, active, fetchPage, pageSize, startedAt } = args;
  const pool = await getCustomerPool(request.customerId);
  const client = await pool.connect();
  let inserted = 0;
  let elapsed = 0;
  try {
    await client.query("BEGIN");

    // Encode policies inside the transaction so an
    // `InlinePolicyEncodingError` rolls back any partial work and
    // flows through the same `markRunFailed` path as fetch / DB
    // errors. The claimed `policy_triage_run` row already exists at
    // this point; marking it `failed` honours #460's acceptance
    // criterion that encoding errors transition the run to
    // `status='failed'` with `last_error` populated.
    const encodedPolicies = request.policies.map(translatePolicyToInlineInput);

    let after: string | null = null;
    let truncated = false;
    let lastHasNextPage = false;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      if (request.signal?.aborted) {
        throw new Error("aborted by caller");
      }
      const variables: CorpusBFetchVariables = {
        filter: {
          start: request.periodStartIso,
          end: request.periodEndIso,
          customers: [String(request.customerId)],
        },
        triage: {
          policies: encodedPolicies,
          exclusions: exclusionsForResolver(active.rules),
        },
        first: pageSize,
        after,
      };
      const response = await fetchPage(variables, request.signal);
      const conn = response.eventListWithTriage;
      const rows: Omit<PolicyTriagedEventRow, "runId">[] = [];
      for (const edge of conn.edges) {
        const event = edge.node;
        const cols = normalizeEventColumns(event);
        // App-side re-application of the active exclusion set. Stage 1
        // already pre-cut what it can; this pass closes the TLS / NTLM
        // gap from review-database#723 with full Domain regex
        // semantics. Drops are fine — corpus B is a single bounded
        // run, so watermark forward-progress is not a concern.
        if (isExcluded(cols, { rules: active.rules })) continue;
        // `eventListWithTriage` returns every event passing the
        // standard filter; non-matching events have `triageScores`
        // null/empty. Persisting them would make "With my policies"
        // surface the full standard-filter corpus with empty score
        // lists instead of the documented zero-row ready result for a
        // no-match run. Drop here so `policy_triaged_event` only
        // carries policy-matched rows.
        const scores = event.triageScores ?? [];
        if (scores.length === 0) continue;
        rows.push({
          eventKey: cursorToEventKey(edge.cursor),
          eventTimeIso: event.time,
          kind: event.__typename,
          sensor: event.sensor,
          origAddr: cols.origAddr,
          origPort: event.origPort ?? null,
          respAddr: cols.respAddr,
          respPort: event.respPort ?? null,
          proto: null,
          host: cols.host,
          dnsQuery: cols.dnsQuery,
          uri: cols.uri,
          category: event.category ?? null,
          snapshot: {
            scores: scores.map((s) => ({
              policyId: Number(s.policyId),
              score: s.score,
            })),
          },
        });
      }
      if (rows.length > 0) {
        inserted += await insertTriagedEventsBatch(client, run.id, rows);
      }
      lastHasNextPage = conn.pageInfo.hasNextPage;
      if (!conn.pageInfo.hasNextPage) break;
      // `hasNextPage = true` with `endCursor = null` is a malformed
      // pagination response: the runner cannot continue paging, so
      // treating it as a clean exit would materialise an incomplete
      // run as `ready`. Surface as a structured failure instead.
      if (conn.pageInfo.endCursor === null) {
        throw new CorpusBMalformedPaginationError();
      }
      after = conn.pageInfo.endCursor;
      if (page + 1 === MAX_PAGES_PER_RUN) {
        truncated = true;
      }
    }
    if (truncated && lastHasNextPage) {
      throw new CorpusBPageCapExceededError(MAX_PAGES_PER_RUN);
    }

    // Mark the run `ready` inside the same transaction as the event
    // INSERTs so the `computing → ready` flip is atomic with the
    // event rows. A crash between event commit and a separate ready
    // UPDATE would otherwise leave the slot occupied as `computing`
    // until 1B-7's reaper noticed.
    elapsed = Date.now() - startedAt;
    const flipped = await markRunReadyOnClient(client, run.id, elapsed);
    if (flipped === 0) {
      // The row was transitioned to a terminal status (`failed` by the
      // reaper, `superseded` by a concurrent recompute) before this
      // runner reached the ready flip. Roll back so the events do not
      // commit under a stale run id and surface the current state of
      // the row instead of reviving the terminal one.
      throw new CorpusBRunSlotLostError();
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Already rolled back / connection broken.
    });
    if (err instanceof CorpusBRunSlotLostError) {
      // The row already has a terminal status — re-read it so the
      // caller sees the actual outcome (failed / superseded) instead
      // of a synthesised one. `markRunFailed` is intentionally NOT
      // called here: its `WHERE status='computing'` guard would no-op
      // anyway, and we must not write `last_error` over the existing
      // terminal row.
      const current = await getRunById(request.customerId, run.id);
      return {
        run: current ?? { ...run, status: "failed", lastError: err.message },
        insertedEventCount: 0,
        reusedCache: false,
      };
    }
    const message = formatRunError(err);
    await markRunFailed(request.customerId, run.id, message).catch(() => {
      // Best-effort: the original error is what matters.
    });
    return {
      run: { ...run, status: "failed", lastError: message },
      insertedEventCount: 0,
      reusedCache: false,
    };
  } finally {
    client.release();
  }
  return {
    run: {
      ...run,
      status: "ready",
      computationDurationMs: elapsed,
      finalizedAtIso: new Date().toISOString(),
    },
    insertedEventCount: inserted,
    reusedCache: false,
  };
}

function formatRunError(err: unknown): string {
  if (err instanceof InlinePolicyEncodingError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

const EVENT_KEY_PATTERN = /^[0-9]{1,39}$/;
function cursorToEventKey(cursor: string): string {
  if (!EVENT_KEY_PATTERN.test(cursor)) {
    throw new Error(
      `Corpus B: malformed edge cursor ${JSON.stringify(cursor)} (expected an unsigned decimal i128 string ≤ 39 digits).`,
    );
  }
  return cursor;
}

async function defaultFetchPage(
  variables: CorpusBFetchVariables,
  signal?: AbortSignal,
): Promise<ResolverPage> {
  const customerIdNum = Number(variables.filter.customers[0]);
  const context = {
    role: CORPUS_B_ROLE,
    customerIds: Number.isFinite(customerIdNum) ? [customerIdNum] : [],
  };
  // biome-ignore format: keep the call on one line so the scope-allowlist
  // override sits on the same line as the graphqlRequest call.
  return graphqlRequest<ResolverPage, CorpusBFetchVariables>(CORPUS_B_EVENT_LIST_QUERY, variables, context, signal); // scope-allowlist: corpus B system-actor runner; customer scope materialised via JWT customer_ids + filter.customers
}

export const _testing = {
  cursorToEventKey,
  exclusionsForResolver,
  CorpusBPageCapExceededError,
  CorpusBMalformedPaginationError,
  CorpusBRunSlotLostError,
  MAX_PAGES_PER_RUN,
};
