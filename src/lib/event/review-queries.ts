import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { type DocumentNode, parse } from "graphql";

/**
 * REview (review-web) GraphQL documents for the Event menu.
 *
 * The Event menu is overwhelmingly Giganto-backed, and its Giganto
 * operations live under `src/lib/event/queries/` — a directory the
 * schema-validation test hard-routes to `schemas/giganto.graphql`. The
 * Periodic Time Series view (E5 Part 2) additionally needs REview's
 * `samplingPolicyList` to populate its `id` selector, which must validate
 * against `schemas/review.graphql`. Routing differs by directory, so the
 * REview documents are kept here, under a **separate**
 * `src/lib/event/review-queries/` tree that falls through to the manager
 * SDL (the default route in `pickSchemaForQueryFile`).
 *
 * This is a second loader rather than an addition to
 * `src/lib/event/queries.ts` because that loader's `QUERIES_DIR` is
 * hard-pinned to the Giganto `queries/` directory. Keeping the REview
 * loader in the Event domain (rather than reusing `src/lib/node/queries`)
 * avoids leaking an Event/Time-Series selector query into the Node
 * domain; it is registered in the `STATIC_QUERY_LOADERS` allowlist of
 * `schema-validation.test.ts` so the dynamic-GraphQL-construction guard
 * recognizes it as a static, checked-in loader.
 *
 * Resolved from `process.cwd()` for the same reason as the sibling
 * Giganto loader: Turbopack rewrites `__dirname` during route bundling.
 */
const QUERIES_DIR = path.join(
  process.cwd(),
  "src",
  "lib",
  "event",
  "review-queries",
);

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

export const SAMPLING_POLICY_LIST_QUERY = loadDocument(
  "sampling-policy-list.graphql",
);
