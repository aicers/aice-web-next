import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  deleteGlobalExclusion,
  getGlobalExclusionById,
} from "@/lib/triage/exclusion/storage";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/triage/exclusions/global/[id]
 *
 * Removes a global exclusion. No retroactive corpus changes —
 * "Future cadences only" per discussion #447 §2.1. The fanout queue's
 * `ON DELETE CASCADE` removes any pending fanout jobs that have not
 * yet run.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id } = await context.params;
    if (!UUID_REGEX.test(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const existing = await getGlobalExclusionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const ok = await deleteGlobalExclusion(id);
    if (!ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await auditLog.record({
      actor: session.accountId,
      action: "triage_exclusion.global_remove",
      target: "triage_exclusion",
      targetId: id,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: {
        id,
        kind: existing.kind,
        value: existing.value,
      },
    });

    return NextResponse.json({ data: { id } });
  },
  { requiredPermissions: ["triage:exclusion:global:write"] },
);
