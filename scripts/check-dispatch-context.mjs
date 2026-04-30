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
//      patterns are accepted, but the contract is "symbol is in
//      scope at runtime", so two shapes intentionally do NOT
//      satisfy the check:
//        * Type-only imports — both `import type { buildDispatchContext } ...`
//          and `import { type buildDispatchContext } ...`. TypeScript
//          erases these so the symbol is not in runtime scope.
//        * Nested declarations — `function buildDispatchContext` /
//          `const buildDispatchContext` inside another function or
//          block. Only top-level (column-0) declarations count.
//
// Per-line override: append `// scope-allowlist: <reason>` to the
// offending call-site line. The reason must be non-empty. The
// override is intentionally noisy in code review so anyone reaching
// for it has to justify it.
//
// Comments, string literals, and split-line calls. The presence and
// call-site checks run against a stripped copy of the source so
// non-executable text — line/block comments AND the *contents* of
// single-quoted, double-quoted, and template-string literals — does
// not influence the result. That means a commented-out
// `import { buildDispatchContext } ...` does NOT satisfy the presence
// requirement, a commented-out call site does NOT count as a real
// call, and a string literal that happens to contain
// `graphqlRequest(...)` or `import { buildDispatchContext } ...`
// (e.g. an error message, log line, or fixture) does NOT trigger or
// satisfy the guard either. The stripper preserves newlines and
// pads non-newline characters inside strings/comments with spaces
// so line/column offsets stay aligned for line-number reporting.
// Call-site detection runs against the whole stripped source (not
// line-by-line) so a call split across lines
// (e.g. `return graphqlRequest\n  (QUERY, ...)`) is still recognized.
// Override-comment lookups still scan the *original* lines so the
// `// scope-allowlist:` annotation can sit on any line of the call
// expression (start through the opening paren).
//
// Caveat: template-literal interpolation expressions (`${...}`) are
// not parsed back out, so a real call buried inside `${...}` is
// missed and an `import { buildDispatchContext }` substring inside
// `${...}` doesn't satisfy the presence check either. Both edges are
// pathological in real source, and the file-level allowlist still
// catches the only meaningful regression — a brand-new server action
// outside `src/lib/{node,detection}` that calls `graphqlRequest`.
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
// both `graphqlRequest` and `graphqlRequestTo`. `\s` matches newlines
// so the regex can detect calls split across lines when run against
// the whole-source string.
const CALL_RE = /\bgraphqlRequest(?:To)?\s*[<(]/g;

// Inline override: `// scope-allowlist: <reason>`. Reason must be
// non-empty (after trimming).
const OVERRIDE_RE = /\/\/\s*scope-allowlist:\s*(.+?)\s*$/;

// `import { ..., buildDispatchContext, ... } from "..."`. Iterates
// every `import { ... } from "..."` statement in the stripped source
// and inspects each specifier individually so type-only imports do
// NOT count: `import type { buildDispatchContext } ...` (whole-import
// type modifier) and `import { type buildDispatchContext } ...`
// (per-specifier type modifier) are both rejected because TypeScript
// erases them at runtime — the symbol is not actually in scope when
// the call site executes. `as` aliases are accepted (the symbol is in
// scope under either name). We do not resolve the import path — any
// path that brings the symbol in scope counts. Run against the
// stripped source so a commented-out import or a string literal that
// happens to contain the import substring is not honoured.
const IMPORT_RE = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*["']/g;

// Top-level declaration only — must start at column 0 (no leading
// whitespace). Nested `function buildDispatchContext` /
// `const buildDispatchContext` declarations inside another function
// or block do NOT bring the symbol into file scope, so they must NOT
// satisfy the presence check. Run against the stripped source so a
// commented-out declaration is not honoured. Anchored on `^` or `\n`
// followed directly by the keyword (no `\s*`) to enforce column 0.
const LOCAL_DECL_RE =
  /(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function\s+buildDispatchContext\b|const\s+buildDispatchContext\b)/;

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

// Strip line/block comments AND the contents of string literals while
// preserving newlines so line numbers stay aligned with the original
// source. Inside a string or comment, non-newline characters become
// spaces and newlines are kept verbatim; the string delimiters
// themselves are emitted so that an `import { ... } from "..."`
// statement still parses as an import (the path content is replaced
// with spaces, but `[^"']*` still matches). Template-literal
// interpolation expressions are NOT parsed back out — `${...}`
// content is treated as part of the string and its substrings will
// not match the call/import regexes. This is a guard, not a TS
// parser; the worst case is a missed match, which the file-level
// allowlist still catches.
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  let stringDelim = null; // null | '"' | "'" | "`"
  let inLineComment = false;
  let inBlockComment = false;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      } else {
        out += " ";
      }
      i++;
    } else if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        out += "  ";
        i += 2;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i++;
      }
    } else if (stringDelim !== null) {
      if (ch === "\\") {
        // Escape sequence: blank both the backslash and the next
        // character, preserving an actual newline in `\<newline>` so
        // line counts stay aligned.
        out += " ";
        if (next) out += next === "\n" ? "\n" : " ";
        i += 2;
        continue;
      }
      if (ch === stringDelim) {
        stringDelim = null;
        out += ch;
        i++;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i++;
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      out += "  ";
      i += 2;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      out += "  ";
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      stringDelim = ch;
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function findCallSites(source) {
  const stripped = stripCommentsAndStrings(source);
  const originalLines = source.split("\n");
  const sites = [];
  CALL_RE.lastIndex = 0;
  for (;;) {
    const match = CALL_RE.exec(stripped);
    if (match === null) break;
    const startLine = stripped.slice(0, match.index).split("\n").length;
    const endLine = stripped
      .slice(0, match.index + match[0].length)
      .split("\n").length;
    sites.push({
      startLine,
      endLine,
      lines: originalLines.slice(startLine - 1, endLine),
    });
  }
  return sites;
}

function hasOverride(lines) {
  for (const line of lines) {
    const m = line.match(OVERRIDE_RE);
    if (m && m[1].trim().length > 0) return true;
  }
  return false;
}

function hasBuildDispatchContextImport(stripped) {
  IMPORT_RE.lastIndex = 0;
  for (;;) {
    const match = IMPORT_RE.exec(stripped);
    if (match === null) return false;
    // Reject `import type { ... }` (whole-import type modifier).
    // The leading `\b` in IMPORT_RE means `match[0]` starts at
    // `import`, so we can test for `type` directly after it.
    if (/^import\s+type\b/.test(match[0])) continue;
    for (const rawSpec of match[1].split(",")) {
      const spec = rawSpec.trim();
      if (spec.length === 0) continue;
      // Reject `{ type buildDispatchContext }` (per-specifier type
      // modifier).
      if (/^type\s+/.test(spec)) continue;
      // Match either a direct specifier (`buildDispatchContext` /
      // `buildDispatchContext as foo`) or a renamed import that
      // brings the symbol into local scope (`foo as
      // buildDispatchContext`). \b boundaries keep us off
      // `myBuildDispatchContext` etc.
      if (/\bbuildDispatchContext\b/.test(spec)) return true;
    }
  }
}

function hasBuildDispatchContext(source) {
  const stripped = stripCommentsAndStrings(source);
  if (hasBuildDispatchContextImport(stripped)) return true;
  if (LOCAL_DECL_RE.test(stripped)) return true;
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
      if (hasOverride(site.lines)) continue;

      if (!allowed) {
        violations.push({
          relPath,
          lineNumber: site.startLine,
          message:
            `Call to graphqlRequest/graphqlRequestTo from ${relPath}:${site.startLine} ` +
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
          lineNumber: site.startLine,
          message:
            `${relPath}:${site.startLine} calls graphqlRequest/graphqlRequestTo ` +
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
