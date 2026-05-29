import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard against env-vs-consumer drift for internal bearer tokens
 * (#652). Two classes of consumer drifted away from
 * `.env.example.prod` and shipped undeclared:
 *
 *   (a) cron wrapper scripts (`infra/cron/run-*.sh`) that read a
 *       `${..._TOKEN:-}` env var to authorize their internal-API call,
 *       and
 *   (b) production `src` code that reads a `process.env.<NAME>_TOKEN`
 *       bearer secret directly from an internal-API route (no wrapper).
 *
 * An undeclared token surfaces only as a runtime `… is empty; refusing
 * to fire` log on the cron container, so the omission is invisible
 * until a job silently never runs. This test makes the omission a CI
 * failure instead.
 *
 * Scope is deliberately narrow to avoid false positives — the repo has
 * many token-named identifiers that are NOT env config (e.g.
 * `MFA_TOKEN_INVALID`, `ACCESS_TOKEN_COOKIE`,
 * `AIMER_CONTEXT_TOKEN_AUDIENCE`). We match ONLY:
 *   (a) `${NAME:-...}` shell parameter expansions whose NAME ends in
 *       `_TOKEN`, inside `infra/cron/run-*.sh`, and
 *   (b) `process.env.NAME` reads whose NAME ends in `_TOKEN`, inside
 *       `src` (tests excluded).
 */

const REPO_ROOT = resolve(__dirname, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env.example.prod");
const CRON_DIR = join(REPO_ROOT, "infra/cron");
const SRC_DIR = join(REPO_ROOT, "src");

/** Names declared (uncommented) in `.env.example.prod`, e.g. `FOO=`. */
function declaredEnvNames(): Set<string> {
  const text = readFileSync(ENV_FILE, "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * `${NAME:-default}` parameter expansions in the cron wrappers whose
 * NAME ends in `_TOKEN`. The `:-` default operator is required so we
 * capture the env read (`TOKEN="${SOME_INTERNAL_TOKEN:-}"`) and never
 * the bare local-variable use (`Authorization: Bearer ${TOKEN}`).
 */
function wrapperTokenRefs(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const files = readdirSync(CRON_DIR).filter(
    (f) => f.startsWith("run-") && f.endsWith(".sh"),
  );
  const pattern = /\$\{([A-Z0-9_]+_TOKEN):-[^}]*\}/g;
  for (const file of files) {
    const text = readFileSync(join(CRON_DIR, file), "utf8");
    for (const m of text.matchAll(pattern)) {
      const list = refs.get(m[1]) ?? [];
      list.push(`infra/cron/${file}`);
      refs.set(m[1], list);
    }
  }
  return refs;
}

/** Recursively collect `.ts`/`.tsx` files under `dir`, skipping tests. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") {
        continue;
      }
      out.push(...collectSourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `process.env.NAME` reads in production `src` whose NAME ends in
 * `_TOKEN`. Anchoring on the `_TOKEN` suffix (plus the `process.env.`
 * prefix) keeps the scan to genuine bearer-token env config and
 * excludes the token-named string/constant false positives.
 */
function srcTokenReads(): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  const pattern = /process\.env\.([A-Z0-9_]+_TOKEN)\b/g;
  for (const file of collectSourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const list = reads.get(m[1]) ?? [];
      list.push(rel);
      reads.set(m[1], list);
    }
  }
  return reads;
}

describe("internal bearer-token declarations in .env.example.prod (#652)", () => {
  const declared = declaredEnvNames();

  it("declares every _TOKEN env expansion referenced by a cron wrapper", () => {
    const refs = wrapperTokenRefs();
    // Sanity: the scan must actually find the known wrappers, or the
    // pattern silently passing would hide real drift.
    expect(refs.size).toBeGreaterThanOrEqual(7);

    const missing = [...refs.entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(missing, "undeclared cron-wrapper tokens").toEqual([]);
  });

  it("declares every internal `process.env.*_TOKEN` read in src", () => {
    const reads = srcTokenReads();
    // Sanity: the full inventory at #652 was 11 consumed tokens.
    expect(reads.size).toBeGreaterThanOrEqual(11);

    const missing = [...reads.entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(missing, "undeclared src process.env token reads").toEqual([]);
  });
});
