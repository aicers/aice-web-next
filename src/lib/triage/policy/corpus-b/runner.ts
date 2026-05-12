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
import {
  type EncodedEventTriagePolicyInput,
  InlinePolicyEncodingError,
  translatePolicyToInlineInput,
} from "@/lib/triage/inline-policy";
import type { TriageEvent } from "@/lib/triage/types";

import { getCustomerPool } from "../customer-db";
import type { TriagePolicyRow } from "../types";

import { computePoliciesFingerprint } from "./fingerprint";
import { CORPUS_B_EVENT_LIST_QUERY } from "./queries";
import {
  findActiveRun,
  insertComputingRun,
  insertTriagedEventsBatch,
  markRunFailed,
  markRunReady,
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

  // Encode policies up front so an encoding error fails the run
  // before any DB writes happen. The runner converts the error into
  // `status='failed'` with a structured `last_error` rather than a
  // panic (acceptance criterion).
  let encodedPolicies: EncodedEventTriagePolicyInput[];
  try {
    encodedPolicies = request.policies.map(translatePolicyToInlineInput);
  } catch (err) {
    return failBeforeInsert(request, err);
  }

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
    encodedPolicies,
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

  let encodedPolicies: EncodedEventTriagePolicyInput[];
  try {
    encodedPolicies = request.policies.map(translatePolicyToInlineInput);
  } catch (err) {
    return failBeforeInsert(request, err);
  }

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
    encodedPolicies,
    active,
    fetchPage,
    pageSize,
    startedAt,
  });
}

interface ClaimedSlotArgs {
  request: CorpusBRunRequest;
  run: PolicyTriageRunRow;
  encodedPolicies: EncodedEventTriagePolicyInput[];
  active: ActiveExclusionSet;
  fetchPage: (
    variables: CorpusBFetchVariables,
    signal?: AbortSignal,
  ) => Promise<ResolverPage>;
  pageSize: number;
  startedAt: number;
}

async function runInsideClaimedSlot(
  args: ClaimedSlotArgs,
): Promise<CorpusBRunResult> {
  const {
    request,
    run,
    encodedPolicies,
    active,
    fetchPage,
    pageSize,
    startedAt,
  } = args;
  const pool = await getCustomerPool(request.customerId);
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    let after: string | null = null;
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
            scores: (event.triageScores ?? []).map((s) => ({
              policyId: Number(s.policyId),
              score: s.score,
            })),
          },
        });
      }
      if (rows.length > 0) {
        inserted += await insertTriagedEventsBatch(client, run.id, rows);
      }
      if (!conn.pageInfo.hasNextPage) break;
      if (conn.pageInfo.endCursor === null) break;
      after = conn.pageInfo.endCursor;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Already rolled back / connection broken.
    });
    const message = err instanceof Error ? err.message : String(err);
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
  const elapsed = Date.now() - startedAt;
  await markRunReady(request.customerId, run.id, elapsed);
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

const EVENT_KEY_PATTERN = /^[0-9]{1,39}$/;
function cursorToEventKey(cursor: string): string {
  if (!EVENT_KEY_PATTERN.test(cursor)) {
    throw new Error(
      `Corpus B: malformed edge cursor ${JSON.stringify(cursor)} (expected an unsigned decimal i128 string ≤ 39 digits).`,
    );
  }
  return cursor;
}

/**
 * Shape an encoding-error failure response without writing any row.
 * The acceptance criterion requires encoding errors to surface as
 * `status='failed'` with `last_error` populated — but encoding fails
 * before a row is INSERTed, so we synthesise a pseudo-row that carries
 * the same shape the caller would otherwise see, and leave the
 * persistence as a no-op. Production callers should also forward the
 * structured `InlinePolicyEncodingError` to their audit log.
 */
function failBeforeInsert(
  request: CorpusBRunRequest,
  err: unknown,
): CorpusBRunResult {
  const message =
    err instanceof InlinePolicyEncodingError
      ? `${err.kind}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  const nowIso = new Date().toISOString();
  return {
    run: {
      id: "0",
      ownerAccountId: request.ownerAccountId,
      periodStartIso: request.periodStartIso,
      periodEndIso: request.periodEndIso,
      policiesFingerprint: "",
      exclusionsFingerprint: "",
      baselineVersion: request.baselineVersion,
      status: "failed",
      replaces: null,
      supersededBy: null,
      refreshReason: request.refreshReason,
      computationDurationMs: null,
      lastError: message,
      createdAtIso: nowIso,
      finalizedAtIso: nowIso,
    },
    insertedEventCount: 0,
    reusedCache: false,
  };
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
  failBeforeInsert,
};
