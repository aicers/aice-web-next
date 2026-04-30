#!/usr/bin/env node
// Static dispatch-context guard.
//
// Fails CI when a `graphqlRequest` / `graphqlRequestTo` call site is
// added in a file that is not allowed to issue customer-scoped
// requests, or in an allowlisted file that has neither an import nor
// a local declaration of `buildDispatchContext`. The guard is a
// pragmatic file-level check, not a deep dataflow analysis: deeper
// correctness (e.g. "the value passed as the third argument was
// actually derived from `buildDispatchContext` for *this* call site")
// still relies on code review. The point is to catch the regression
// where a new server action wires up `graphqlRequest` and forgets the
// scope plumbing entirely.
//
// Two layers:
//
//   1. File-level allowlist. Only files matching one of the patterns
//      in `ALLOWED_DIRS` may call `graphqlRequest` /
//      `graphqlRequestTo`. The GraphQL client modules themselves
//      (`src/lib/graphql/client.ts`, `src/lib/graphql/external-client.ts`)
//      are also allowed because that is where the helpers live.
//
//   2. `buildDispatchContext` presence. For every allowlisted file
//      that calls one of the helpers, the file must either import
//      `buildDispatchContext` from another module **or** declare it
//      locally as a top-level function / const. Detection's track
//      uses the local-declaration form today
//      (`src/lib/detection/server-actions.ts`); the Node track
//      imports it from `src/lib/node/dispatch-context.ts`. Both
//      patterns are accepted.
//
// Per-line override: append `// scope-allowlist: <reason>` to the
// offending call-site line. The reason must be non-empty. The
// override is intentionally noisy in code review so anyone reaching
// for it has to justify it.
//
// Run via `pnpm check:scope`. Tests live at
// `src/__tests__/scripts/check-dispatch-context.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

// Files that are permitted to issue customer-scoped GraphQL requests.
// Keep this list small and explicit. New entries should accompany an
// architectural change, not an ordinary feature PR.
const ALLOWED_DIRS = ["src/lib/node", "src/lib/detection"];

// The GraphQL client modules themselves define and re-dispatch the
// helpers; they have no caller-side scope to materialize and are
// exempt from the `buildDispatchContext` presence check. Listing them
// explicitly (rather than folding them into `ALLOWED_DIRS`) keeps the
// "every consumer must build a dispatch context" rule unambiguous for
// every other allowlisted file.
const CLIENT_MODULES = new Set([
  "src/lib/graphql/client.ts",
  "src/lib/graphql/external-client.ts",
]);

// Directories that are excluded from the scan entirely. Tests and the
// test harness exercise the helpers against fixtures and mock servers
// where customer scope is supplied by the test fixture, not derived
// from a real session.
const EXCLUDED_DIRS = [
  "src/__tests__",
  "src/__integration__",
  "src/test-harness",
];

// Source extensions to scan.
const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// Matches a real call site (`name(` or `name<…>(`) of the helpers.
// `\b` ensures we don't match `myGraphqlRequest(`. The `To?` covers
// both `graphqlRequest` and `graphqlRequestTo`.
const CALL_RE = /\bgraphqlRequest(?:To)?\s*[<(]/;

// Inline override: `// scope-allowlist: <reason>`. Reason must be
// non-empty (after trimming).
const OVERRIDE_RE = /\/\/\s*scope-allowlist:\s*(.+?)\s*$/;

// `import { ..., buildDispatchContext, ... } from "..."`. Allows
// arbitrary whitespace and `as` aliases between the braces. We do not
// resolve the import path — any path that brings the symbol in scope
// counts.
const IMPORT_BUILD_DISPATCH_CONTEXT_RE =
  /import\s*(?:type\s+)?\{[^}]*\bbuildDispatchContext\b[^}]*\}\s*from\s*["'][^"']+["']/;

// `(async )?function buildDispatchContext(...)` or
// `(export )?const buildDispatchContext = ...`.
const LOCAL_DECL_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+buildDispatchContext\b|const\s+buildDispatchContext\b)/;

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
    const abs = path.join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Skip excluded test dirs early — even files within them that
      // mention `graphqlRequest` are out of scope for the guard.
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
        continue;
      }
      if (entry === "node_modules" || entry === ".next") continue;
      walk(abs, out);
    } else if (SOURCE_EXTS.has(path.extname(entry))) {
      out.push(abs);
    }
  }
}

function isInAllowedDir(relPath) {
  return ALLOWED_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`));
}

function findCallSites(source) {
  const lines = source.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CALL_RE.test(line)) {
      sites.push({ lineNumber: i + 1, line });
    }
  }
  return sites;
}

function hasOverride(line) {
  const match = line.match(OVERRIDE_RE);
  if (!match) return false;
  const reason = match[1].trim();
  return reason.length > 0;
}

function hasBuildDispatchContext(source) {
  if (IMPORT_BUILD_DISPATCH_CONTEXT_RE.test(source)) return true;
  if (LOCAL_DECL_RE.test(source)) return true;
  return false;
}

/**
 * Run the guard against a virtual file system. Used by tests so they
 * can supply fixture sources without touching the worktree.
 *
 * @param {Array<{ relPath: string, source: string }>} files
 * @returns {Array<{ relPath: string, lineNumber: number, message: string }>}
 *   List of violations. Empty array means the guard passes.
 */
export function checkFiles(files) {
  const violations = [];
  for (const { relPath, source } of files) {
    const sites = findCallSites(source);
    if (sites.length === 0) continue;

    const isClientModule = CLIENT_MODULES.has(relPath);
    const allowed = isClientModule || isInAllowedDir(relPath);

    for (const site of sites) {
      if (hasOverride(site.line)) continue;

      if (!allowed) {
        violations.push({
          relPath,
          lineNumber: site.lineNumber,
          message:
            `Call to graphqlRequest/graphqlRequestTo from ${relPath}:${site.lineNumber} ` +
            "is outside the dispatch-context allowlist. Customer-scoped " +
            "GraphQL requests must originate from src/lib/node, " +
            "src/lib/detection, or the GraphQL client modules. If the call " +
            "is intentional, append `// scope-allowlist: <reason>` to the " +
            "line with a justification.",
        });
        continue;
      }

      // Client modules define / pass through the helpers and have no
      // caller-side scope to materialize — skip the presence check.
      if (isClientModule) continue;

      // Allowlisted file: confirm `buildDispatchContext` is in scope.
      if (!hasBuildDispatchContext(source)) {
        violations.push({
          relPath,
          lineNumber: site.lineNumber,
          message:
            `${relPath}:${site.lineNumber} calls graphqlRequest/graphqlRequestTo ` +
            "but neither imports nor locally declares `buildDispatchContext`. " +
            "Customer scope must be materialized through " +
            "`buildDispatchContext(session)` before dispatch. Use " +
            "`// scope-allowlist: <reason>` only when the omission is " +
            "deliberate (e.g. a non-customer-scoped manager query).",
        });
      }
    }
  }
  return violations;
}

function main() {
  const srcDir = path.join(ROOT, "src");
  const files = listSourceFiles(srcDir);
  const inputs = files.map((abs) => ({
    relPath: path.relative(ROOT, abs).split(path.sep).join("/"),
    source: readFileSync(abs, "utf8"),
  }));

  const violations = checkFiles(inputs);
  if (violations.length === 0) {
    console.log(
      `[check:scope] OK — scanned ${inputs.length} file(s), no violations.`,
    );
    return 0;
  }

  console.error(`[check:scope] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  • ${v.relPath}:${v.lineNumber}`);
    console.error(`    ${v.message}\n`);
  }
  return 1;
}

// Only run the CLI when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  process.exit(main());
}
