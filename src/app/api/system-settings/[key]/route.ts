import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { updateSystemSetting } from "@/lib/auth/system-settings";

export const PATCH = withAuth(
  async (request, context, session) => {
    const { key } = await context.params;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const value = body.value;
    if (value === undefined) {
      return NextResponse.json(
        { error: "Missing required field: value" },
        { status: 400 },
      );
    }

    const result = await updateSystemSetting(key, value);
    if (!result.valid) {
      return NextResponse.json(
        { error: "Validation failed", details: result.errors },
        { status: 400 },
      );
    }

    await auditLog.record({
      actor: session.accountId,
      action: "system_settings.update",
      target: "system_settings",
      targetId: key,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { key, value },
    });

    return NextResponse.json({ data: result.data });
  },
  { requiredPermissions: ["system-settings:write"] },
);
