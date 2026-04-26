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

const QUERIES_DIR = path.join(__dirname, "queries");

function loadDocument(relativePath: string): DocumentNode {
  const full = path.join(QUERIES_DIR, relativePath);
  const source = readFileSync(full, "utf8");
  return parse(source);
}

// ── Manager (review-web) operations ────────────────────────────────

export const NODE_LIST_QUERY = loadDocument("node-list.graphql");
export const NODE_DETAIL_QUERY = loadDocument("node-detail.graphql");
export const NODE_STATUS_LIST_QUERY = loadDocument("node-status-list.graphql");
export const INSERT_NODE_MUTATION = loadDocument("insert-node.graphql");
export const UPDATE_NODE_DRAFT_MUTATION = loadDocument(
  "update-node-draft.graphql",
);
export const REMOVE_NODES_MUTATION = loadDocument("remove-nodes.graphql");
export const APPLY_NODE_MUTATION = loadDocument("apply-node.graphql");
export const NODE_REBOOT_MUTATION = loadDocument("node-reboot.graphql");
export const NODE_SHUTDOWN_MUTATION = loadDocument("node-shutdown.graphql");

// ── External services (Giganto, Tivan) ─────────────────────────────

export const GIGANTO_STATUS_QUERY = loadDocument(
  "external/giganto-status.graphql",
);
export const GIGANTO_CONFIG_QUERY = loadDocument(
  "external/giganto-config.graphql",
);
export const GIGANTO_UPDATE_CONFIG_MUTATION = loadDocument(
  "external/giganto-update-config.graphql",
);
export const TIVAN_STATUS_QUERY = loadDocument("external/tivan-status.graphql");
export const TIVAN_CONFIG_QUERY = loadDocument("external/tivan-config.graphql");
export const TIVAN_UPDATE_CONFIG_MUTATION = loadDocument(
  "external/tivan-update-config.graphql",
);
