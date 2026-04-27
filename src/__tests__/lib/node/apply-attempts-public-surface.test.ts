import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static-analysis acceptance test (#359 / #361, "no mock-backed
 * server action escapes to production").
 *
 * Maintains the closed set of `"use server"` exports on the
 * ApplyAttempt subsystem. Adding a new exported action without
 * updating the explicit allow-list below fails CI here.
 *
 * Closed set:
 *   - `apply-attempts.ts` → `createApplyAttempt` (#359)
 *   - `apply-actions.ts`  → `confirmApplyAttempt`, `retryDispatch` (#361)
 *
 * The internal lifecycle module DOES NOT carry the `"use server"`
 * directive. Its only outward-facing entry points are named under
 * `_internal_*` so they are obviously not callable from a UI
 * request directly; #361's `"use server"` wrappers are the
 * sanctioned surface that binds them to a production GraphQL
 * dispatcher.
 *
 * `apply.ts` ships the production `ApplyDispatcher` and the renamed
 * `_internal_applyNodeViaManager` helper. It must NOT carry
 * `"use server"` and must NOT export an `applyNode` symbol — the
 * deny-list below catches a future contributor accidentally
 * re-promoting the manager wrapper to a server action and
 * bypassing the bulk-apply lifecycle.
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

  it("apply-actions.ts carries the 'use server' directive (#361)", () => {
    const source = readSource("src/lib/node/apply-actions.ts");
    const firstLine = source.split("\n", 1)[0].trim();
    expect(firstLine).toBe('"use server";');
  });

  it("apply-actions.ts exports exactly two server actions: confirmApplyAttempt and retryDispatch", async () => {
    const mod = await import("@/lib/node/apply-actions");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exportedFunctions).toEqual(["confirmApplyAttempt", "retryDispatch"]);
  });

  it("apply.ts does NOT carry 'use server' (production dispatcher is internal)", () => {
    const source = readSource("src/lib/node/apply.ts");
    const firstSubstantiveLine = source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("//") && !l.startsWith("/*"));
    expect(firstSubstantiveLine).not.toBe('"use server";');
  });

  it("apply.ts retains the renamed manager helper under _internal_applyNodeViaManager", async () => {
    const mod = await import("@/lib/node/apply");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(exportedFunctions).toContain("_internal_applyNodeViaManager");
    // Deny-list: the renamed helper must NOT be re-exposed under the
    // old name. A future contributor accidentally re-promoting it to
    // a server action would surface here. The prior surface
    // (server-actions.ts:applyNode) is also covered below.
    expect(exportedFunctions).not.toContain("applyNode");
  });

  it("server-actions.ts no longer exposes the applyNode wrapper as a public export (#361 deny-list)", async () => {
    const mod = await import("@/lib/node/server-actions");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    // The wrapper has been relocated to apply.ts and renamed to
    // `_internal_applyNodeViaManager`. The user-facing entry is now
    // the `confirmApplyAttempt` lifecycle path. Re-promoting it to a
    // server action accidentally fails CI here.
    expect(exportedFunctions).not.toContain("applyNode");
  });
});
