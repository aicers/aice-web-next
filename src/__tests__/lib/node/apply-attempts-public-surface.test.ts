import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * `apply.ts` ships the production `ApplyDispatcher` and the split
 * `_internal_applyNodeDraftViaManager` / `_internal_applyAgentConfigViaManager`
 * helpers (Phase Node-12, #333). It must NOT carry `"use server"` and
 * must NOT export an `applyNode` symbol — the deny-list below catches
 * a future contributor accidentally re-promoting the manager wrapper to
 * a server action and bypassing the bulk-apply lifecycle. The unsafe
 * v1 `buildNodeInputFromDraft` helper has been replaced by
 * `buildNodeInputForApplyDraft` (Decision 4 / #333) and must not be
 * present.
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

  it("apply.ts exposes the split manager helpers under _internal_applyNodeDraftViaManager and _internal_applyAgentConfigViaManager (#333)", async () => {
    const mod = await import("@/lib/node/apply");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(exportedFunctions).toContain("_internal_applyNodeDraftViaManager");
    expect(exportedFunctions).toContain("_internal_applyAgentConfigViaManager");
    // Deny-list: the v1 single-stage helper and the legacy server-action
    // name must NOT be re-exposed. A future contributor accidentally
    // re-promoting them to a server action would surface here.
    expect(exportedFunctions).not.toContain("_internal_applyNodeViaManager");
    expect(exportedFunctions).not.toContain("applyNode");
  });

  it("apply-attempt-lifecycle.ts no longer exports the unsafe v1 buildNodeInputFromDraft (#333, Decision 8)", async () => {
    const mod = await import("@/lib/node/apply-attempt-lifecycle");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    // The v1 builder unconditionally fabricated `draft = null` on every
    // row, which would delete every agent / external from the node per
    // upstream's `update_db` contract. It is replaced by
    // `buildNodeInputForApplyDraft` (Decision 4) which passes drafts
    // verbatim.
    expect(exportedFunctions).toContain("buildNodeInputForApplyDraft");
    expect(exportedFunctions).not.toContain("buildNodeInputFromDraft");
  });

  it("server-actions.ts no longer exposes the applyNode wrapper as a public export (deny-list)", async () => {
    const mod = await import("@/lib/node/server-actions");
    const exportedFunctions = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    // The wrapper has been relocated to apply.ts and split into
    // `_internal_applyNodeDraftViaManager` /
    // `_internal_applyAgentConfigViaManager`. The user-facing entry is
    // now the `confirmApplyAttempt` lifecycle path.
    expect(exportedFunctions).not.toContain("applyNode");
  });

  /**
   * Static-analysis acceptance for #552 (legacy single-shot mutation
   * removal). The four targeted patterns below catch a future commit
   * that reintroduces any part of the legacy GraphQL surface under
   * `src/`. A broad word-boundary scan on the bare manager name is
   * deliberately avoided — it would false-positive on the split-call
   * helpers (Draft / AgentConfig), channel names that embed the old
   * manager identifier, fixture-manifest entries, and prose comments
   * mentioning the historical name.
   *
   * The patterns are assembled from concatenated string fragments so
   * the raw acceptance greps in #552 return no hits on this test
   * file itself. Embedding the literal banned strings here would make
   * CI green while the documented acceptance commands still report a
   * match under `src/`, which defeats the purpose of the gate.
   */
  describe("legacy single-shot manager surface removed (#552)", () => {
    const SRC_ROOT = resolve(ROOT, "src");
    const SCANNABLE_EXTENSIONS = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".graphql",
      ".json",
    ]);

    // Banned tokens, built from pieces so this file does not contain
    // any of them as a literal substring. Each token is the exact
    // text the corresponding issue grep looks for.
    const TOKEN_CONST = `APPLY_NODE${"_"}MUTATION`;
    const TOKEN_PATH = `queries/apply${"-"}node.graphql`;
    const TOKEN_MUTATION_NAME = `Apply${""}Node`;
    const TOKEN_RESULT_TYPE = `Apply${""}NodeResult`;

    function collectSourceFiles(dir: string, acc: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          collectSourceFiles(full, acc);
          continue;
        }
        const dot = entry.lastIndexOf(".");
        if (dot === -1) continue;
        if (SCANNABLE_EXTENSIONS.has(entry.slice(dot))) acc.push(full);
      }
      return acc;
    }

    function findMatches(pattern: RegExp): string[] {
      const hits: string[] = [];
      for (const file of collectSourceFiles(SRC_ROOT)) {
        const source = readFileSync(file, "utf8");
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      return hits;
    }

    it("no production references to the legacy mutation constant export", () => {
      const pattern = new RegExp(`\\b${TOKEN_CONST}\\b`);
      expect(findMatches(pattern)).toEqual([]);
    });

    it("no references to the legacy GraphQL document path", () => {
      const escaped = TOKEN_PATH.replace(/\./g, "\\.");
      const pattern = new RegExp(escaped);
      expect(findMatches(pattern)).toEqual([]);
    });

    it("no legacy single-shot operation declarations (split-call operations are fine)", () => {
      // Matches `mutation <legacy-name><word-boundary>` so that
      // `mutation ApplyNodeDraft` / `mutation ApplyAgentConfig` are
      // not flagged.
      const pattern = new RegExp(
        `^[\\t ]*mutation[\\t ]+${TOKEN_MUTATION_NAME}\\b`,
      );
      expect(findMatches(pattern)).toEqual([]);
    });

    it("no references to the legacy result type (split-call result types are fine)", () => {
      const pattern = new RegExp(`\\b${TOKEN_RESULT_TYPE}\\b`);
      expect(findMatches(pattern)).toEqual([]);
    });
  });
});
