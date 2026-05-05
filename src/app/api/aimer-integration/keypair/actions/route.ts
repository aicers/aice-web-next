import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import {
  deactivateAimerSigningPreviousKey,
  generateAimerSigningKey,
  getAimerSigningKeyStatus,
  rotateAimerSigningKey,
  switchAimerSigningKey,
} from "@/lib/aimer/signing-key";
import { auditLog } from "@/lib/audit/logger";
import type { AuditAction } from "@/lib/audit/schema";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";

type Action = "generate" | "rotate" | "switch" | "deactivate";

const ALLOWED_ACTIONS: ReadonlySet<Action> = new Set([
  "generate",
  "rotate",
  "switch",
  "deactivate",
]);

const AUDIT_FOR: Record<Action, AuditAction> = {
  generate: "aimer_signing_key.generated",
  rotate: "aimer_signing_key.rotated",
  switch: "aimer_signing_key.switched",
  deactivate: "aimer_signing_key.deactivated",
};

export const POST = withAuth(async (request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action;
  if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action as Action)) {
    return NextResponse.json(
      { error: "Unknown or missing action" },
      { status: 400 },
    );
  }

  const typedAction = action as Action;

  try {
    let details: Record<string, unknown> = {};
    let auditTargetId: string | undefined;

    switch (typedAction) {
      case "generate": {
        const result = await generateAimerSigningKey();
        details = { kid: result.kid };
        auditTargetId = result.kid;
        break;
      }
      case "rotate": {
        const result = await rotateAimerSigningKey();
        details = { pendingKid: result.kid };
        auditTargetId = result.kid;
        break;
      }
      case "switch": {
        const confirmRegistered = body.confirmRegistered === true;
        const result = await switchAimerSigningKey({ confirmRegistered });
        details = {
          activeKid: result.activeKid,
          previousKid: result.previousKid,
          confirmRegistered,
        };
        auditTargetId = result.activeKid;
        break;
      }
      case "deactivate": {
        // No `force` bypass on the public API. The retention window
        // (context-token TTL + clock-skew margin) protects in-flight
        // verification on aimer-web's side; the only legitimate
        // override is the test-only env var consumed inside the lib.
        const result = deactivateAimerSigningPreviousKey();
        details = { previousKid: result.previousKid };
        auditTargetId = result.previousKid;
        break;
      }
    }

    await auditLog.record({
      actor: session.accountId,
      action: AUDIT_FOR[typedAction],
      target: "system_settings",
      targetId: auditTargetId,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details,
    });

    const status = await getAimerSigningKeyStatus();
    return NextResponse.json({ data: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Operation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
