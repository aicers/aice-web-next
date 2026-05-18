import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/audit/schema";

describe("aimer audit actions are registered in the closed union", () => {
  const expected = [
    "aimer_signing_key.generated",
    "aimer_signing_key.rotated",
    "aimer_signing_key.switched",
    "aimer_signing_key.deactivated",
    "aimer_integration_setting.changed",
    "aimer_context_token.issued",
    "aimer_context_token.denied",
    "aimer_detection_send.issued",
    "aimer_detection_send.denied",
    "aimer_phase2.sync_now",
    "aimer_phase2.backfill",
    "aimer_phase2.opportunistic_paused",
    "aimer_phase2.opportunistic_resumed",
  ] as const;

  it.each(expected)("includes %s", (action) => {
    expect(AUDIT_ACTIONS).toContain(action);
  });

  it("registers exactly the expected aimer_* actions", () => {
    const aimerActions = (AUDIT_ACTIONS as readonly string[]).filter((a) =>
      a.startsWith("aimer_"),
    );
    expect(aimerActions).toHaveLength(expected.length);
    expect(new Set(aimerActions)).toEqual(new Set(expected));
  });
});
