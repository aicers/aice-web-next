import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { type DocumentNode, parse } from "graphql";

/**
 * Triage GraphQL documents.
 *
 * The `TriageEventFields` fragment is the single source for the
 * per-subtype Event selection used by both the period-walking
 * `eventList` query and the per-id `event(id:)` fetch added in #561.
 * The two operations compose the fragment via a `# requires:` header
 * line so a field added to the fragment flows to both call sites
 * without a hand-edit. The schema-validation test
 * (`src/__tests__/lib/graphql/schema-validation.test.ts`) walks the
 * `.graphql` files transitively through the same loader so a malformed
 * fragment is caught before runtime.
 *
 * Loaded once at module init; downstream callers receive an
 * already-parsed `DocumentNode`.
 */

// Resolved from `process.cwd()` rather than `__dirname` for the same
// reason `src/lib/node/queries.ts` does: Turbopack rewrites
// `__dirname` to a virtual path during route bundling that doesn't
// exist on the real filesystem. `process.cwd()` is the project root in
// dev, build, and tests; in the standalone runtime it is the
// standalone output directory, which `next.config.ts`'s
// `outputFileTracingIncludes` populates with the same relative
// `src/lib/triage/queries/` tree.
const QUERIES_DIR = path.join(process.cwd(), "src", "lib", "triage", "queries");

const REQUIRES_DIRECTIVE = /^#\s*requires:\s*(\S+)\s*$/;

function readRequires(source: string): string[] {
  const requires: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) break;
    const match = REQUIRES_DIRECTIVE.exec(line);
    if (match?.[1]) requires.push(match[1]);
  }
  return requires;
}

function composeSource(
  relativePath: string,
  visited: Set<string> = new Set(),
): string {
  if (visited.has(relativePath)) return "";
  visited.add(relativePath);
  const full = path.join(QUERIES_DIR, relativePath);
  const source = readFileSync(full, "utf8");
  const dependencies = readRequires(source).map((req) =>
    path.posix.join(path.posix.dirname(relativePath), req),
  );
  const parts = dependencies.map((dep) => composeSource(dep, visited));
  parts.push(source);
  return parts.join("\n");
}

function loadDocument(relativePath: string): DocumentNode {
  return parse(composeSource(relativePath));
}

/**
 * Triage `eventList` query — Phase 1.A baseline (discussion #447 §3.2,
 * §3.3, §3.4). The actual per-subtype selection lives in
 * {@link event-fields.graphql} so the per-id `event(id:)` query below
 * stays in sync without duplicating it.
 */
export const TRIAGE_EVENT_LIST_QUERY = loadDocument("event-list.graphql");

/**
 * Per-id event fetch query (#561). The Story-member Tier 2 resolver
 * issues this once per member event-key in parallel so the Tier 2
 * predicate can be evaluated in-app against the cohort. Reuses the
 * same `TriageEventFields` fragment as `eventList` so the returned
 * payload shape is identical — a member event flows through the same
 * downstream pivot-index / detail-panel rendering paths as an event
 * sourced from the period walk.
 */
export const TRIAGE_EVENT_BY_ID_QUERY = loadDocument("event-by-id.graphql");
