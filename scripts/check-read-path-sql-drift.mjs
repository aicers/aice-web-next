#!/usr/bin/env node
// Static SQL-drift guard for the Phase 1.B menu read path (issue #524 §4).
//
// PR #525 introduced five queries that #528 will measure
// (`selectMenuCohort`, `countObserved`, `countTriaged`,
// `perAssetObservedCounts`, `selectAssetDetailEventsBatch`). The
// measurement contract requires the harness and the production caller
// to share the same SQL text byte-for-byte; a copy in `scripts/` would
// silently diverge the moment production SQL is edited. This guard
// fails CI if any of the shape patterns unique to those five queries
// reappear in string literals outside the shared module
// `src/lib/triage/baseline/read-path-sql.mjs`.
//
// Patterns
// --------
//
//   * `WITH scored AS (` co-occurring with
//     `cume_dist() OVER (PARTITION BY` — the §3 read-time scoring CTE
//     that prefixes both `selectMenuCohort` and
//     `selectAssetDetailEventsBatch`.
//   * `ROW_NUMBER() OVER (PARTITION BY orig_addr` — the per-asset
//     top-N selection from `selectAssetDetailEventsBatch`.
//   * `orig_addr::text = ANY(` — the pre-§5-cleanup cast form, kept
//     as a regression guard so a future contributor cannot silently
//     reintroduce it after this PR removes it.
//
// Bare table-name matches (`baseline_triaged_event`, `observed_event_meta`)
// are intentionally NOT in this check. Those names appear legitimately
// in the harness's own profile-assertion SQL, in test fixtures and
// integration-test setup, in migration files under
// `migrations/customer/`, and in future read paths. Forcing every such
// occurrence through the shared module would balloon it beyond its
// purpose. The shape-specific patterns above already catch the
// regression that matters — an inlined copy of one of the five
// measured queries — without that collateral cost.
//
// Allowlist
// ---------
//
// Files / paths under `EXEMPT_PATHS` may legitimately contain these
// patterns:
//
//   * The shared module itself — the SQL legitimately lives here.
//   * Tests under `src/__tests__/` and `src/__integration__/` —
//     fixture SQL doesn't compete with production drift.
//   * Migration files under `migrations/` — `cume_dist() OVER (PARTITION BY`
//     legitimately appears in a future migration that materializes the
//     same shape; the inline-SQL-in-string regression only matters in
//     application code.
//   * This script and the SQL-drift test under
//     `src/__tests__/scripts/`, which both reference the patterns
//     literally so the guard can be tested and documented.
//
// The harness script under `scripts/measure-baseline-read-path.mjs` is
// NOT exempt — it imports the SQL from the shared module, and if it
// ever inlines a copy that's exactly the regression this guard catches.
//
// Run via `pnpm check:sql-drift`. Tests live at
// `src/__tests__/scripts/check-read-path-sql-drift.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

// Drift patterns. Each pattern is paired with a human-readable label
// included in the violation message so the operator can identify
// which fragment tripped the guard.
const PATTERNS = [
  {
    label:
      "`WITH scored AS (` co-occurring with `cume_dist() OVER (PARTITION BY`",
    test: (source) =>
      /\bWITH\s+scored\s+AS\s*\(/i.test(source) &&
      /cume_dist\(\)\s+OVER\s*\(\s*PARTITION\s+BY/i.test(source),
  },
  {
    label: "`ROW_NUMBER() OVER (PARTITION BY orig_addr`",
    test: (source) =>
      /ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION\s+BY\s+orig_addr/i.test(source),
  },
  {
    label: "`orig_addr::text = ANY(` (pre-§5 cast regression)",
    test: (source) => /orig_addr::text\s*=\s*ANY\s*\(/i.test(source),
  },
];

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);

// Paths exempt from the scan. Each entry is matched literally OR as a
// directory prefix (`relPath === entry || relPath.startsWith(`${entry}/`)`).
const EXEMPT_PATHS = [
  "src/lib/triage/baseline/read-path-sql.mjs",
  "src/lib/triage/baseline/read-path-sql.d.ts",
  "src/__tests__",
  "src/__integration__",
  "scripts/check-read-path-sql-drift.mjs",
];

// Directories excluded from the walk entirely.
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
]);

function isExempt(relPath) {
  return EXEMPT_PATHS.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

function listSourceFiles(dir) {
  const out = [];
  walk(dir, out);
  return out;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (SOURCE_EXTS.has(path.extname(entry))) {
      out.push(abs);
    }
  }
}

/**
 * Extract string-literal contents from a source file. The drift guard
 * targets SQL embedded in JS/TS string literals (single, double, or
 * template-string), not free-floating code that mentions SQL keywords
 * in identifiers or comments. Returns one string per literal so
 * pattern matchers can ignore inter-literal context.
 *
 * Comments are skipped entirely. Template-literal interpolation
 * expressions are also skipped (matching the dispatch-context
 * guard's behaviour); a real SQL fragment buried inside `${...}` is
 * pathological in practice.
 */
export function extractStringLiterals(source) {
  const literals = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const delim = ch;
      i++;
      let buf = "";
      while (i < source.length && source[i] !== delim) {
        if (source[i] === "\\") {
          if (i + 1 < source.length) {
            buf += source[i + 1];
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (source[i] === "\n") {
          // Bare newline inside `"..."` / `'...'` is a syntax error in
          // real JS; treat as literal end so a partially-parsed file
          // does not consume the rest of the source.
          break;
        }
        buf += source[i];
        i++;
      }
      if (i < source.length) i++; // skip closing delim
      literals.push(buf);
      continue;
    }
    if (ch === "`") {
      i++;
      let buf = "";
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
          if (i + 1 < source.length) {
            buf += source[i + 1];
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          // Skip a balanced ${...} block. Nested braces inside the
          // expression (e.g. object literals) are depth-counted so we
          // resume reading the template at the matching `}`.
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            i++;
          }
          continue;
        }
        buf += source[i];
        i++;
      }
      if (i < source.length) i++; // skip closing backtick
      literals.push(buf);
      continue;
    }
    i++;
  }
  return literals;
}

/**
 * Run the guard against a virtual file system. Used by tests so they
 * can supply fixture sources without touching the worktree.
 *
 * @param {Array<{ relPath: string, source: string }>} files
 * @returns {Array<{ relPath: string, pattern: string }>}
 */
export function checkFiles(files) {
  const violations = [];
  for (const { relPath, source } of files) {
    if (isExempt(relPath)) continue;
    const literals = extractStringLiterals(source);
    for (const literal of literals) {
      for (const pattern of PATTERNS) {
        if (pattern.test(literal)) {
          violations.push({ relPath, pattern: pattern.label });
        }
      }
    }
  }
  return violations;
}

function main() {
  const inputs = [];
  for (const subdir of ["src", "scripts"]) {
    const dir = path.join(ROOT, subdir);
    for (const abs of listSourceFiles(dir)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      inputs.push({ relPath: rel, source: readFileSync(abs, "utf8") });
    }
  }
  const violations = checkFiles(inputs);
  if (violations.length === 0) {
    console.log(
      `[check:sql-drift] OK — scanned ${inputs.length} file(s), no inlined ` +
        "copies of the measured-query SQL shapes outside the shared module.",
    );
    return 0;
  }
  console.error(
    `[check:sql-drift] FAIL — ${violations.length} violation(s). The five ` +
      "measured queries must live in `src/lib/triage/baseline/read-path-sql.mjs` " +
      "and be imported from both the production caller and the harness. " +
      "Inlining a copy silently breaks the measurement contract with #528.\n",
  );
  for (const v of violations) {
    console.error(`  • ${v.relPath}`);
    console.error(`    matched: ${v.pattern}\n`);
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  process.exit(main());
}
