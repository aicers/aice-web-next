/**
 * Phase 2 admin backfill (RFC 0002 §6, sub-issue #573 Trigger 3).
 *
 * Reads the existing baseline / story rows for a historical
 * `[from, to)` window, builds sub-divided refresh-shaped payloads,
 * and enqueues them as `backfill_baseline_window` /
 * `backfill_story_window` notices in one short transaction. Same
 * payload shape as refresh-window; only the queue-kind discriminator
 * (and the drain-emitted `schema_version`) distinguishes backfill
 * from refresh so aimer-web's verifier and audit can pivot
 * independently of the endpoint path.
 *
 * The route owner (`src/app/api/internal/aimer/phase2/backfill/route.ts`)
 * is responsible for auth, body validation, and translating thrown
 * errors into HTTP status codes; this module owns the per-customer
 * DB work and the per-request enqueue atomicity.
 */

import "server-only";

import { timingSafeEqual } from "node:crypto";

import {
  buildBaselineRefreshPayloads,
  buildStoryRefreshPayloads,
  loadBaselineRefreshRows,
  loadStoryRefreshRows,
  logSubdivideWarnings,
} from "@/lib/aimer/phase2/payload-builders";
import { enqueueNotice } from "@/lib/aimer/phase2/state";
import { PHASE_1B_BASELINE_VERSION } from "@/lib/triage/baseline/cadence";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

export type Phase2BackfillKind = "baseline_event" | "story";

export interface Phase2BackfillInput {
  customerId: number;
  kind: Phase2BackfillKind;
  fromIso: string;
  toIso: string;
}

export interface Phase2BackfillResult {
  enqueuedNoticeIds: string[];
}

/**
 * Thrown when an admin backfill window spans more than one
 * `baseline_version`. The refresh / backfill payload contract carries
 * a single top-level `baseline_version`, so a mixed-version window
 * cannot be faithfully represented as one notice. RFC 0001 allows
 * older versions to remain in the 180-day corpus, so this is a real
 * caller-supplied error (400) rather than an internal invariant
 * violation. Route maps it to HTTP 400.
 */
export class Phase2BackfillMultiVersionError extends Error {
  readonly baselineVersions: string[];

  constructor(baselineVersions: string[]) {
    super(
      `Backfill window spans ${baselineVersions.length} baseline_versions ` +
        `(${baselineVersions.join(", ")}); refresh / backfill payloads ` +
        "carry a single top-level baseline_version. Narrow the window " +
        "so all rows share one version.",
    );
    this.name = "Phase2BackfillMultiVersionError";
    this.baselineVersions = baselineVersions;
  }
}

/**
 * Constant-time check for the `Bearer <token>` header on the admin
 * backfill route. Reads the shared secret from
 * `AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN`. Separate from
 * `APPLY_INTERNAL_CLEANUP_TOKEN` so the two internal surfaces can be
 * rotated and audited independently. Refuses every request when the
 * env var is unset, matching the convention of the other internal
 * routes (`apply-attempts/cleanup`, `triage/story/rebuild`).
 */
export function verifyPhase2BackfillToken(provided: string | null): boolean {
  const expected = process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Run the admin backfill for one customer / kind / window.
 *
 * All sub-window enqueues share **one** short transaction so the
 * request is atomically all-or-nothing — a DB error mid-loop rolls
 * back every notice from this request, never leaving aimer-web with
 * a partial backfill it could be expected to ack.
 *
 * Throws {@link CustomerNotFoundError} when `customerId` does not
 * resolve to an active customer; propagates DB errors otherwise.
 */
export async function runPhase2Backfill(
  input: Phase2BackfillInput,
): Promise<Phase2BackfillResult> {
  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  const enqueuedNoticeIds: string[] = [];
  try {
    await client.query("BEGIN");
    if (input.kind === "baseline_event") {
      const { events, baselineVersion, baselineVersions } =
        await loadBaselineRefreshRows(client, {
          fromIso: input.fromIso,
          toIso: input.toIso,
        });
      if (baselineVersions.length > 1) {
        throw new Phase2BackfillMultiVersionError(baselineVersions);
      }
      const { payloads, warnings } = buildBaselineRefreshPayloads({
        window: { from: input.fromIso, to: input.toIso },
        // Empty windows still emit one notice (`events[]` empty); the
        // signing schema requires a non-empty `baseline_version`, so
        // fall back to the active version constant. Semantically this
        // is "the current version says this historical window is
        // empty," which is the right thing to tell aimer-web for a
        // backfill range we have no rows for.
        baselineVersion: baselineVersion ?? PHASE_1B_BASELINE_VERSION,
        events,
      });
      logSubdivideWarnings(
        input.customerId,
        "backfill_baseline_window",
        warnings,
      );
      for (const payload of payloads) {
        const id = await enqueueNotice(
          input.customerId,
          "backfill_baseline_window",
          payload,
          client,
        );
        enqueuedNoticeIds.push(id);
      }
    } else {
      const stories = await loadStoryRefreshRows(client, {
        fromIso: input.fromIso,
        toIso: input.toIso,
      });
      const { payloads, warnings } = buildStoryRefreshPayloads({
        window: { from: input.fromIso, to: input.toIso },
        stories,
      });
      logSubdivideWarnings(input.customerId, "backfill_story_window", warnings);
      for (const payload of payloads) {
        const id = await enqueueNotice(
          input.customerId,
          "backfill_story_window",
          payload,
          client,
        );
        enqueuedNoticeIds.push(id);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { enqueuedNoticeIds };
}
