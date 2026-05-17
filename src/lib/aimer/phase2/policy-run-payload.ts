/**
 * Policy-run Send-to-aimer payload builder (RFC 0002 §6
 * `phase2.policy_run.v1`, sub-issue #572).
 *
 * Loads `policy_triage_run` metadata and a byte-budgeted slice of
 * `policy_triaged_event` rows, projects them onto the wire shape, and
 * returns:
 *
 *   - `payload`  — the full `phase2.policy_run.v1` payload (sans
 *     `external_key` / `source_aice_id`; those are injected by
 *     `buildPhase2Push`).
 *   - `lastEventKey` — exclusive upper bound the *next* batch should
 *     pass as `after_event_key` (`null` only on an empty terminal
 *     slice).
 *   - `hasMore` — true when more rows exist past this slice.
 *
 * The builder unwraps the runner's DB-side
 * `PolicyTriageScoreSnapshot = { scores: [...] }` to the flat wire array
 * `policy_triage_snapshot` per the Phase 2 schema. The unwrap is one
 * place so a future schema change is localized.
 */

import "server-only";

import type pg from "pg";

import { PHASE2_REFRESH_PAYLOAD_MAX_BYTES } from "./payload-builders";

// ── Tunables ───────────────────────────────────────────────────────

/**
 * Per-batch byte budget for the inner `events_data` payload. Reuses the
 * shared refresh / backfill budget so the streaming, refresh, and
 * policy-run payload paths converge on one cap; aimer-web's
 * `BRIDGE_MAX_PAYLOAD_BYTES` (~50 MB) leaves headroom for the JWS
 * envelope overhead.
 */
export const POLICY_RUN_PAYLOAD_MAX_BYTES = PHASE2_REFRESH_PAYLOAD_MAX_BYTES;

/**
 * Reserve subtracted from the budget before slicing to account for the
 * `external_key` + `source_aice_id` fields `buildPhase2Push` injects at
 * envelope time. Worst-case bytes: an external_key of 256 UTF-16 code
 * units mapping to 3 bytes each in UTF-8, plus the JSON wrappers, plus
 * the bounded ASCII aice_id. Mirroring `PHASE2_BASELINE_AUGMENT_RESERVE_BYTES`
 * here keeps the cap stable when the schemas grow new sibling fields.
 */
const AUGMENT_RESERVE_BYTES = 1024;

// ── Wire shapes ────────────────────────────────────────────────────

export interface PolicyRunWireBody {
  run_id: string;
  owner_account_id: string;
  period_start: string;
  period_end: string;
  created_at: string;
  finalized_at: string;
  baseline_version: string;
  policies_fingerprint: string;
  exclusions_fingerprint: string;
  status: "ready" | "superseded";
  replaces?: string;
  summary_stats?: { total_events: number; kinds_represented: number };
}

export interface PolicyRunWireEvent {
  event_key: string;
  event_time: string;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  policy_triage_snapshot: Record<string, unknown>[];
}

export interface PolicyRunPayload {
  run: PolicyRunWireBody;
  events: PolicyRunWireEvent[];
}

// ── DB row shapes ──────────────────────────────────────────────────

interface PolicyRunSql {
  id: string;
  owner_account_id: string;
  period_start: string;
  period_end: string;
  created_at: string;
  finalized_at: string | null;
  baseline_version: string;
  policies_fingerprint: string;
  exclusions_fingerprint: string;
  status: "computing" | "ready" | "failed" | "superseded";
  replaces: string | null;
  total_events: string;
  kinds_represented: string;
}

interface PolicyEventSql {
  event_key: string;
  event_time: string;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  policy_triage_snapshot: unknown;
}

// ── Error type ─────────────────────────────────────────────────────

export type PolicyRunLoadErrorCode =
  | "run_not_found"
  | "run_not_eligible"
  | "run_owner_unset";

export class PolicyRunLoadError extends Error {
  readonly code: PolicyRunLoadErrorCode;
  /** When `code === "run_not_eligible"`, the rejected status value. */
  readonly status?: string;

  constructor(code: PolicyRunLoadErrorCode, message: string, status?: string) {
    super(message);
    this.name = "PolicyRunLoadError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ── DB loaders ─────────────────────────────────────────────────────

/**
 * Load the `policy_triage_run` row identified by `runId` and project
 * it onto the wire body shape. Throws {@link PolicyRunLoadError} when
 * the run does not exist or is not in a Sendable state.
 *
 * Eligible statuses: `'ready'`, `'superseded'`. `'computing'` and
 * `'failed'` are explicitly rejected — there's no useful outcome to
 * send for either.
 *
 * `summary_stats` is computed by joining `policy_triaged_event` so the
 * Settings indicator + audit log can quote the count without re-reading
 * the table.
 */
export async function loadPolicyRunForSend(
  client: pg.PoolClient,
  runId: string,
): Promise<PolicyRunWireBody> {
  const { rows } = await client.query<PolicyRunSql>(
    `SELECT r.id::text                                AS id,
            r.owner_account_id::text                  AS owner_account_id,
            to_char(r.period_start AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')  AS period_start,
            to_char(r.period_end   AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')  AS period_end,
            to_char(r.created_at   AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')  AS created_at,
            CASE WHEN r.finalized_at IS NULL THEN NULL
                 ELSE to_char(r.finalized_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END                                       AS finalized_at,
            r.baseline_version,
            r.policies_fingerprint,
            r.exclusions_fingerprint,
            r.status,
            r.replaces::text                          AS replaces,
            COALESCE(s.total_events,        0)::text  AS total_events,
            COALESCE(s.kinds_represented,   0)::text  AS kinds_represented
       FROM policy_triage_run r
       LEFT JOIN (
         SELECT run_id,
                COUNT(*)               AS total_events,
                COUNT(DISTINCT kind)   AS kinds_represented
           FROM policy_triaged_event
          WHERE run_id = $1::bigint
          GROUP BY run_id
       ) s ON s.run_id = r.id
      WHERE r.id = $1::bigint`,
    [runId],
  );
  const row = rows[0];
  if (!row) {
    throw new PolicyRunLoadError(
      "run_not_found",
      `policy_triage_run ${runId} not found`,
    );
  }
  if (row.status !== "ready" && row.status !== "superseded") {
    throw new PolicyRunLoadError(
      "run_not_eligible",
      `policy_triage_run ${runId} status ${row.status} is not sendable`,
      row.status,
    );
  }
  if (row.finalized_at === null) {
    // A `ready`/`superseded` run always has `finalized_at` set by the
    // runner — defend the wire contract anyway so a malformed corpus
    // row doesn't slip through to aimer-web as `"finalized_at": null`.
    throw new PolicyRunLoadError(
      "run_not_eligible",
      `policy_triage_run ${runId} has no finalized_at`,
      row.status,
    );
  }
  const body: PolicyRunWireBody = {
    run_id: row.id,
    owner_account_id: row.owner_account_id,
    period_start: row.period_start,
    period_end: row.period_end,
    created_at: row.created_at,
    finalized_at: row.finalized_at,
    baseline_version: row.baseline_version,
    policies_fingerprint: row.policies_fingerprint,
    exclusions_fingerprint: row.exclusions_fingerprint,
    status: row.status,
    summary_stats: {
      total_events: Number(row.total_events),
      kinds_represented: Number(row.kinds_represented),
    },
  };
  if (row.replaces) body.replaces = row.replaces;
  return body;
}

/**
 * Unwrap the runner's DB-side `{ scores: [...] }` snapshot to the wire's
 * flat array. Exported so the test suite can pin the contract.
 *
 * Accepts both the canonical object form (`{ scores: [...] }`) and a
 * legacy/edge flat-array form so a partially-migrated corpus does not
 * crash the Send. An empty `scores` produces an empty wire array
 * (NOT an empty object).
 */
export function unwrapPolicyTriageSnapshot(
  raw: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    // Legacy / forward-compat — already flat.
    return raw.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }
  if (raw !== null && typeof raw === "object" && "scores" in raw) {
    const scores = (raw as { scores: unknown }).scores;
    if (Array.isArray(scores)) {
      return scores.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      );
    }
  }
  // Defensive default — the DB column is `JSONB NOT NULL`, so an
  // unrecognised shape is corrupt data; emit an empty array on the wire
  // rather than crashing the Send.
  return [];
}

function rowToWireEvent(row: PolicyEventSql): PolicyRunWireEvent {
  return {
    event_key: row.event_key,
    event_time: row.event_time,
    kind: row.kind,
    sensor: row.sensor,
    orig_addr: row.orig_addr,
    orig_port: row.orig_port,
    resp_addr: row.resp_addr,
    resp_port: row.resp_port,
    proto: row.proto,
    host: row.host,
    dns_query: row.dns_query,
    uri: row.uri,
    category: row.category,
    policy_triage_snapshot: unwrapPolicyTriageSnapshot(
      row.policy_triage_snapshot,
    ),
  };
}

// ── Slice / batch builder ──────────────────────────────────────────

export interface PolicyRunSliceResult {
  payload: PolicyRunPayload;
  /**
   * The `event_key` the next batch should pass as `after_event_key`.
   * Null only when the slice is empty (terminal first batch for a
   * zero-event run). For a non-empty slice this is the largest
   * `event_key` in the current batch.
   */
  lastEventKey: string | null;
  /**
   * True when more rows exist past this slice (i.e. the next
   * `build-envelope` call would return rows). False on the terminal
   * batch.
   */
  hasMore: boolean;
  /** Wire `events.length` of this batch. */
  eventCount: number;
}

interface BuildSliceOptions {
  /** Per-batch byte budget. Defaults to {@link POLICY_RUN_PAYLOAD_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * Build one batch of a Send. The caller has already validated `runId`
 * tenant scope and ensured the run is eligible (`ready`/`superseded`).
 *
 * Algorithm: ascending `event_key` scan with strict cursor `event_key
 * > afterEventKey`. Probe-and-trim until the serialized payload fits
 * `maxBytes - AUGMENT_RESERVE_BYTES`. A single oversize row is admitted
 * as its own batch (the atomicity rule has no smaller unit; aimer-web's
 * own size budget would still reject it, but better to surface that on
 * the wire than crash here).
 *
 * Empty runs (no rows ever, or no rows past the cursor) produce a
 * payload with `events: []` and `lastEventKey: null`. The route writes
 * one terminal inflight row and the finalize call can complete the Send
 * with `eventCount: 0`.
 */
export async function buildPolicyRunSlice(
  client: pg.PoolClient,
  runBody: PolicyRunWireBody,
  afterEventKey: string | null,
  options: BuildSliceOptions = {},
): Promise<PolicyRunSliceResult> {
  const maxBytes = options.maxBytes ?? POLICY_RUN_PAYLOAD_MAX_BYTES;
  const budget = Math.max(1, maxBytes - AUGMENT_RESERVE_BYTES);

  // Probe one row past the budget so `has_more` can distinguish "ended
  // exactly on budget" from "more rows past the slice".
  const { rows } = await client.query<PolicyEventSql>(
    `SELECT event_key::text                  AS event_key,
            to_char(event_time AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS event_time,
            kind,
            sensor,
            host(orig_addr)::text            AS orig_addr,
            orig_port,
            host(resp_addr)::text            AS resp_addr,
            resp_port,
            proto,
            host,
            dns_query,
            uri,
            category,
            policy_triage_snapshot
       FROM policy_triaged_event
      WHERE run_id = $1::bigint
        AND ($2::numeric IS NULL OR event_key > $2::numeric)
      ORDER BY event_key ASC`,
    [runBody.run_id, afterEventKey],
  );

  if (rows.length === 0) {
    const payload: PolicyRunPayload = {
      run: runBody,
      events: [],
    };
    return {
      payload,
      lastEventKey: null,
      hasMore: false,
      eventCount: 0,
    };
  }

  // Project all rows, then trim by greedy serialized-byte probe.
  const wireEvents = rows.map(rowToWireEvent);

  // Walk forward keeping the largest k that fits.
  let included = 0;
  for (let k = 1; k <= wireEvents.length; k += 1) {
    const candidate: PolicyRunPayload = {
      run: runBody,
      events: wireEvents.slice(0, k),
    };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes <= budget || included === 0) {
      // Atomicity-of-one: always admit the first row even if it alone
      // exceeds the budget. aimer-web's own cap will reject the
      // monster row with a clear error, which is better signal than
      // an opaque sender-side empty batch.
      included = k;
      if (bytes > budget && k === 1) {
        // First row already over budget — stop here, emit it alone.
        break;
      }
    } else {
      break;
    }
  }

  const sliced = wireEvents.slice(0, included);
  const hasMore = included < wireEvents.length;
  const lastEventKey = sliced[sliced.length - 1].event_key;

  return {
    payload: {
      run: runBody,
      events: sliced,
    },
    lastEventKey,
    hasMore,
    eventCount: sliced.length,
  };
}

export const _testing = {
  AUGMENT_RESERVE_BYTES,
};
