import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { type DocumentNode, parse } from "graphql";

/**
 * GraphQL documents for the Node management dispatch layer.
 *
 * Every document is loaded from a checked-in `.graphql` file under
 * `src/lib/node/queries/` so the schema-validation test in
 * `src/__tests__/lib/graphql/schema-validation.test.ts` can validate
 * each document against the SDL of the backend that will actually
 * answer it (manager → `schemas/review.graphql`, Giganto →
 * `schemas/giganto.graphql`, Tivan → `schemas/tivan.graphql`).
 *
 * The `parse()` calls happen once at module init; downstream callers
 * receive an already-parsed `DocumentNode`. Loading via `fs.readFileSync`
 * avoids needing a Next.js webpack loader for `.graphql` imports — the
 * BFF only runs server-side, so there is no client bundle to worry
 * about.
 */

// Resolved from `process.cwd()` rather than `__dirname` because
// Turbopack rewrites `__dirname` to a virtual `/ROOT/...` path during
// route bundling, which does not exist on the real filesystem when
// Next.js collects page data from the bundled module. `process.cwd()`
// is the project root in dev, build, and tests; in standalone runtime
// it is the standalone output directory, which the
// `outputFileTracingIncludes` entry in `next.config.ts` populates with
// the same relative `src/lib/node/queries/` tree.
const QUERIES_DIR = path.join(process.cwd(), "src", "lib", "node", "queries");

/**
 * Operations declare fragment dependencies via a header line of the
 * form `# requires: <relative-path>`. Each referenced file is read
 * from disk, transitively resolved, and prepended to the operation
 * source before parsing — so a fragment shared by multiple operations
 * (e.g. `node-fields.graphql`) lives in exactly one source-of-truth
 * `.graphql` file and the schema-validation test sees the same
 * composed document the runtime does.
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

// ── Manager (review-web) operations ────────────────────────────────

export const NODE_LIST_QUERY = loadDocument("node-list.graphql");
export const NODE_DETAIL_QUERY = loadDocument("node-detail.graphql");
export const NODE_AUDIT_METADATA_QUERY = loadDocument(
  "node-audit-metadata.graphql",
);
export const NODE_STATUS_LIST_QUERY = loadDocument("node-status-list.graphql");
export const INSERT_NODE_MUTATION = loadDocument("insert-node.graphql");
export const UPDATE_NODE_DRAFT_MUTATION = loadDocument(
  "update-node-draft.graphql",
);
export const REMOVE_NODES_MUTATION = loadDocument("remove-nodes.graphql");
export const APPLY_NODE_DRAFT_MUTATION = loadDocument(
  "apply-node-draft.graphql",
);
export const APPLY_AGENT_CONFIG_MUTATION = loadDocument(
  "apply-agent-config.graphql",
);
export const NODE_REBOOT_MUTATION = loadDocument("node-reboot.graphql");
export const NODE_SHUTDOWN_MUTATION = loadDocument("node-shutdown.graphql");

// ── External services (Giganto, Tivan) ─────────────────────────────

export const GIGANTO_STATUS_QUERY = loadDocument(
  "external/giganto-status.graphql",
);
export const GIGANTO_CONFIG_QUERY = loadDocument(
  "external/giganto-config.graphql",
);
export const GIGANTO_PCAP_QUERY = loadDocument("external/giganto-pcap.graphql");
export const GIGANTO_PACKETS_QUERY = loadDocument(
  "external/giganto-packets.graphql",
);
export const GIGANTO_UPDATE_CONFIG_MUTATION = loadDocument(
  "external/giganto-update-config.graphql",
);
export const TIVAN_STATUS_QUERY = loadDocument("external/tivan-status.graphql");
export const TIVAN_CONFIG_QUERY = loadDocument("external/tivan-config.graphql");
export const TIVAN_UPDATE_CONFIG_MUTATION = loadDocument(
  "external/tivan-update-config.graphql",
);
