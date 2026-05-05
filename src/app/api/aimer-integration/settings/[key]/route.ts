import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import {
  AIMER_SETTING_KEYS,
  type AimerSettingKey,
  updateAimerIntegrationSetting,
} from "@/lib/aimer/settings";
import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";

function isAimerSettingKey(key: string): key is AimerSettingKey {
  return (AIMER_SETTING_KEYS as readonly string[]).includes(key);
}

export const PATCH = withAuth(async (request, context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { key } = await context.params;
  if (!isAimerSettingKey(key)) {
    return NextResponse.json(
      { error: "Unknown Aimer integration setting key" },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const value = body.value;
  if (typeof value !== "string") {
    return NextResponse.json(
      { error: "value must be a string" },
      { status: 400 },
    );
  }

  const result = await updateAimerIntegrationSetting(key, value);
  if (!result.valid) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await auditLog.record({
    actor: session.accountId,
    action: "aimer_integration_setting.changed",
    target: "system_settings",
    targetId: key,
    ip: extractClientIp(request),
    sid: session.sessionId,
    details: {
      key,
      old: result.oldValue,
      new: result.newValue,
    },
  });

  return NextResponse.json({
    data: { key, value: result.newValue },
  });
});
