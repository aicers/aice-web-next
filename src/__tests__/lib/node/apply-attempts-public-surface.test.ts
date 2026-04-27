import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static-analysis acceptance test (#359, "no mock-backed server action
 * escapes to production").
 *
 * Two complementary checks:
 *
 *   1. The public `apply-attempts.ts` module ships exactly ONE server
 *      action — `createApplyAttempt`. Adding a new exported `"use server"`
 *      action accidentally fails CI here.
 *   2. The internal lifecycle module DOES NOT carry the `"use server"`
 *      directive. Its only outward-facing entry points are named under
 *      `_internal_*` so they are obviously not callable from a UI
 *      request. #361 will wrap them in real server actions; this PR
 *      ships them only for unit/integration tests.
 */

const ROOT = resolve(__dirname, "../../../..");

function readSource(relative: string): string {
  return readFileSync(resolve(ROOT, relative), "utf8");
}

describe("apply-attempts public surface", () => {
  it("apply-attempts.ts carries the 'use server' directive", () => {
    const source = readSource("src/lib/node/apply-attempts.ts");
    const firstLine = source.split("\n", 1)[0].trim();
    expect(firstLine).toBe('"use server";');
  });

  it("apply-attempts.ts exports exactly one server action: createApplyAttempt", async () => {
    const mod = await import("@/lib/node/apply-attempts");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exportedFunctions).toEqual(["createApplyAttempt"]);
  });

  it("apply-attempt-lifecycle.ts does NOT carry 'use server'", () => {
    const source = readSource("src/lib/node/apply-attempt-lifecycle.ts");
    const firstSubstantiveLine = source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("//") && !l.startsWith("/*"));
    expect(firstSubstantiveLine).not.toBe('"use server";');
    expect(firstSubstantiveLine).not.toBe("'use server';");
  });

  it("lifecycle entry points are exposed only under _internal_* names", async () => {
    const mod = await import("@/lib/node/apply-attempt-lifecycle");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    // The two entry points must exist under their internal names.
    expect(exportedFunctions).toContain("_internal_confirmApplyAttempt");
    expect(exportedFunctions).toContain("_internal_retryDispatch");
    // No public confirmApplyAttempt / retryDispatch is exported here —
    // those land in #361 as proper server actions wrapping a production
    // dispatcher.
    expect(exportedFunctions).not.toContain("confirmApplyAttempt");
    expect(exportedFunctions).not.toContain("retryDispatch");
  });

  it("apply-attempt-cleanup.ts does NOT carry 'use server'", () => {
    const source = readSource("src/lib/node/apply-attempt-cleanup.ts");
    const firstSubstantiveLine = source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("//") && !l.startsWith("/*"));
    expect(firstSubstantiveLine).not.toBe('"use server";');
  });
});
