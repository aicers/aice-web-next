import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
    "aimer_analyze_envelope.issued",
    "aimer_analyze_envelope.denied",
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

/**
 * Regression guard: the four `aimer_context_token.*` /
 * `aimer_detection_send.*` actions were stopped emitting in #629
 * (analyze-bridge rewire) but retained in the closed union so
 * historical audit rows remain queryable through the filter UI and
 * the API allowlist. The emit call sites all lived inside the deleted
 * routes; if a future PR adds a new emitter under the deprecated
 * action name, this test fires before it ships.
 */
describe("deprecated aimer audit actions have no production emitters", () => {
  const DEPRECATED = [
    "aimer_context_token.issued",
    "aimer_context_token.denied",
    "aimer_detection_send.issued",
    "aimer_detection_send.denied",
  ] as const;

  // Allowlist: places where the bare action string MAY appear without
  // implying a live emitter. Limited to the closed-union schema, the
  // policy map, the i18n labels, and this test file.
  const ALLOWED_FILES = new Set(
    [
      "src/lib/audit/schema.ts",
      "src/lib/audit/customer-scope-policy.ts",
      "src/i18n/messages/en.json",
      "src/i18n/messages/ko.json",
    ].map((p) => path.resolve(p)),
  );

  function* walkSrc(dir: string): IterableIterator<string> {
    for (const name of readdirSync(dir)) {
      if (name === "__tests__") continue;
      const full = path.join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) {
        yield* walkSrc(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|json)$/.test(name)) continue;
      yield full;
    }
  }

  it("no production source under src/ references the deprecated action strings (outside the allowlist)", () => {
    const offenders: { file: string; action: string }[] = [];
    const root = path.resolve("src");
    for (const file of walkSrc(root)) {
      if (ALLOWED_FILES.has(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const action of DEPRECATED) {
        if (text.includes(action)) {
          offenders.push({ file: path.relative(process.cwd(), file), action });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
