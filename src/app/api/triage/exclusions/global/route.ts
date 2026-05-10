import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { withTransaction } from "@/lib/db/client";
import {
  createGlobalExclusion,
  enqueueGlobalExclusionFanout,
  listGlobalExclusions,
  StoredExclusionConflictError,
} from "@/lib/triage/exclusion/storage";
import {
  type ParsedStoredExclusion,
  parseStoredExclusionInput,
  StoredExclusionValidationError,
} from "@/lib/triage/exclusion/storage-input";

/**
 * GET /api/triage/exclusions/global
 *
 * Lists global triage exclusions from `auth_db.global_triage_exclusion`.
 * Read-only; gated only on `triage:read` so a Security Monitor can see
 * what is in effect even though only `triage:exclusion:global:write`
 * can mutate.
 */
export const GET = withAuth(
  async () => {
    const rows = await listGlobalExclusions();
    return NextResponse.json({ data: rows });
  },
  { requiredPermissions: ["triage:read"] },
);

/**
 * POST /api/triage/exclusions/global
 *
 * Creates a global exclusion. The synchronous in-request work:
 *   1. Validate + normalize input.
 *   2. INSERT into `auth_db.global_triage_exclusion`.
 *   3. INSERT one fanout job per active customer into the durable
 *      queue (`triage_exclusion_fanout_job`).
 *   4. Emit a `triage_exclusion.global_add` audit row carrying
 *      `details.fanoutEnqueued`.
 *
 * All steps share one `auth_db` transaction so a crashed runner
 * cannot leave a global row inserted with no fanout enqueued. The
 * per-tenant retroactive DELETE runs out-of-band in
 * `POST /api/internal/triage/exclusion/fanout`.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json(
        { error: "Body must be a JSON object" },
        { status: 400 },
      );
    }
    const body = raw as { kind?: unknown; value?: unknown; note?: unknown };

    let parsed: ParsedStoredExclusion;
    try {
      parsed = parseStoredExclusionInput({
        kind: typeof body.kind === "string" ? body.kind : "",
        value: typeof body.value === "string" ? body.value : "",
        note:
          body.note === undefined || body.note === null
            ? null
            : typeof body.note === "string"
              ? body.note
              : "",
      });
    } catch (err) {
      if (err instanceof StoredExclusionValidationError) {
        return NextResponse.json(
          {
            error: err.message,
            field: err.field,
            code: err.code,
          },
          { status: 400 },
        );
      }
      throw err;
    }

    try {
      const { row, fanoutEnqueued } = await withTransaction(async (client) => {
        const created = await createGlobalExclusion(client, {
          kind: parsed.kind,
          value: parsed.value,
          domainSuffix: parsed.domainSuffix,
          note: parsed.note,
          createdBy: session.accountId,
        });
        const { enqueued } = await enqueueGlobalExclusionFanout(
          client,
          created.id,
        );
        return { row: created, fanoutEnqueued: enqueued };
      });

      await auditLog.record({
        actor: session.accountId,
        action: "triage_exclusion.global_add",
        target: "triage_exclusion",
        targetId: row.id,
        ip: extractClientIp(request),
        sid: session.sessionId,
        details: {
          id: row.id,
          kind: row.kind,
          value: row.value,
          fanoutEnqueued,
        },
      });

      return NextResponse.json({ data: row }, { status: 201 });
    } catch (err) {
      if (err instanceof StoredExclusionConflictError) {
        return NextResponse.json(
          {
            error: err.message,
            field: "value",
            code: "duplicate",
          },
          { status: 409 },
        );
      }
      throw err;
    }
  },
  { requiredPermissions: ["triage:exclusion:global:write"] },
);
