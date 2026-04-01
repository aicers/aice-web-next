import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { query } from "@/lib/db/client";

export const PATCH = withAuth(
  async (request, context, session) => {
    const { id: idStr } = await context.params;
    const id = Number(idStr);
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: "Invalid role ID" }, { status: 400 });
    }

    let body: { mfaRequired?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body.mfaRequired !== "boolean") {
      return NextResponse.json(
        { error: "mfaRequired must be a boolean" },
        { status: 400 },
      );
    }

    // Check role exists
    const { rows } = await query<{ id: number }>(
      "SELECT id FROM roles WHERE id = $1",
      [id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Role not found" }, { status: 404 });
    }

    await query(
      "UPDATE roles SET mfa_required = $1, updated_at = NOW() WHERE id = $2",
      [body.mfaRequired, id],
    );

    await auditLog.record({
      actor: session.accountId,
      action: "role.update",
      target: "role",
      targetId: idStr,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { mfa_required: body.mfaRequired },
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["roles:write"] },
);
