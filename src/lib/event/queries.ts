import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { type DocumentNode, parse } from "graphql";

/**
 * GraphQL documents for the Event menu's Giganto data layer.
 *
 * Every document is loaded from a checked-in `.graphql` file under
 * `src/lib/event/queries/` so the schema-validation test in
 * `src/__tests__/lib/graphql/schema-validation.test.ts` can validate
 * each document against `schemas/giganto.graphql` — the SDL of the
 * service (Giganto) that actually answers these queries. The whole
 * directory is routed to the Giganto SDL by `pickSchemaForQueryFile`,
 * so files here do not need a `giganto-` filename prefix (unlike the
 * mixed-target `src/lib/node/queries/external/` directory).
 *
 * Mirrors the loader in `src/lib/node/queries.ts`: `parse()` runs once
 * at module init via `fs.readFileSync` (no Next.js webpack loader for
 * `.graphql` imports — the BFF only runs server-side), and downstream
 * callers receive an already-parsed `DocumentNode`.
 */

// Resolved from `process.cwd()` rather than `__dirname` for the same
// reason as `src/lib/node/queries.ts`: Turbopack rewrites `__dirname`
// to a virtual path during route bundling. `process.cwd()` is the
// project root in dev, build, and tests; in standalone runtime it is
// the standalone output directory, which the `outputFileTracingIncludes`
// entry in `next.config.ts` populates with the same relative
// `src/lib/event/queries/` tree.
const QUERIES_DIR = path.join(process.cwd(), "src", "lib", "event", "queries");

/**
 * Operations declare fragment dependencies via a header line of the
 * form `# requires: <relative-path>`. Each referenced file is read
 * from disk, transitively resolved, and prepended to the operation
 * source before parsing — so a fragment shared by multiple operations
 * (e.g. `conn-fields.graphql`) lives in exactly one source-of-truth
 * `.graphql` file and the schema-validation test sees the same composed
 * document the runtime does.
 */
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

// ── Giganto network-event operations ───────────────────────────────

export const CONN_RAW_EVENTS_QUERY = loadDocument("conn-raw-events.graphql");
export const EVENT_SENSORS_QUERY = loadDocument("sensors.graphql");
export const STATISTICS_QUERY = loadDocument("statistics.graphql");
