import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const NODE_LIB_DIR = path.join(REPO_ROOT, "src/lib/node");
const GRAPHQL_LIB_DIR = path.join(REPO_ROOT, "src/lib/graphql");

describe("external-endpoints", () => {
  const original = {
    giganto: process.env.GIGANTO_GRAPHQL_ENDPOINT,
    tivan: process.env.TIVAN_GRAPHQL_ENDPOINT,
  };
  beforeEach(() => {
    delete process.env.GIGANTO_GRAPHQL_ENDPOINT;
    delete process.env.TIVAN_GRAPHQL_ENDPOINT;
  });
  afterEach(() => {
    if (original.giganto !== undefined)
      process.env.GIGANTO_GRAPHQL_ENDPOINT = original.giganto;
    else delete process.env.GIGANTO_GRAPHQL_ENDPOINT;
    if (original.tivan !== undefined)
      process.env.TIVAN_GRAPHQL_ENDPOINT = original.tivan;
    else delete process.env.TIVAN_GRAPHQL_ENDPOINT;
  });

  it("getGigantoEndpoint reads from GIGANTO_GRAPHQL_ENDPOINT", async () => {
    process.env.GIGANTO_GRAPHQL_ENDPOINT = "https://giganto.test/graphql";
    const { getGigantoEndpoint } = await import(
      "@/lib/node/external-endpoints"
    );
    expect(getGigantoEndpoint()).toBe("https://giganto.test/graphql");
  });

  it("getTivanEndpoint reads from TIVAN_GRAPHQL_ENDPOINT", async () => {
    process.env.TIVAN_GRAPHQL_ENDPOINT = "https://tivan.test/graphql";
    const { getTivanEndpoint } = await import("@/lib/node/external-endpoints");
    expect(getTivanEndpoint()).toBe("https://tivan.test/graphql");
  });

  it("getGigantoEndpoint throws a clear error when the env var is missing", async () => {
    const { getGigantoEndpoint } = await import(
      "@/lib/node/external-endpoints"
    );
    expect(() => getGigantoEndpoint()).toThrow(/GIGANTO_GRAPHQL_ENDPOINT/);
  });

  it("getTivanEndpoint throws a clear error when the env var is missing", async () => {
    const { getTivanEndpoint } = await import("@/lib/node/external-endpoints");
    expect(() => getTivanEndpoint()).toThrow(/TIVAN_GRAPHQL_ENDPOINT/);
  });
});

/**
 * Static check — the Node management layer must never derive a
 * dispatch URL from a node's config / draft. This was the aice-web
 * pattern (`/archive/${node.graphql_srv_addr}` reverse proxy) and is
 * deliberately not carried over.
 *
 * The check greps the Node management code for any reference to
 * `graphql_srv_addr` (snake_case, the field name in node config TOML)
 * outside of comments and string literals. A property access like
 * `node.graphql_srv_addr` would be a real signal worth catching.
 *
 * String-literal occurrences are tolerated because Phase Node-10's
 * service serialisers legitimately emit `"graphql_srv_addr = ..."`
 * as part of building a draft TOML payload — that is the inverse of
 * a URL lookup and is the correct path. The TypeScript type
 * `graphqlSrvAddr` (camelCase) is also fine — that is the GraphQL
 * field on `GigantoConfig` / `TivanConfig` returned by the per-service
 * `config` query, which is the correct read path.
 */
/**
 * Strip block (`/* … *​/`) and line (`//`) comments from a TypeScript
 * source so the dispatch-URL provenance check below ignores docstring
 * mentions of the field name and only flags real code references.
 * Quoted strings are also stripped so legitimate emission of the
 * snake_case field as a TOML key by Phase Node-10's serialisers does
 * not trip the property-access check.
 */
function stripTsComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\" && i + 1 < source.length) {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

describe("dispatch URL provenance", () => {
  function readAllSourceUnder(dir: string): string {
    const stack: string[] = [dir];
    let combined = "";
    const fs: typeof import("node:fs") = require("node:fs");
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
        ) {
          combined += `\n// ${full}\n`;
          combined += readFileSync(full, "utf8");
        }
      }
    }
    return combined;
  }

  it("Node management code never reads `graphql_srv_addr` to build a dispatch URL", () => {
    const nodeSources = stripTsComments(readAllSourceUnder(NODE_LIB_DIR));
    expect(nodeSources).not.toMatch(/graphql_srv_addr/);
  });

  it("external-client routes via getGigantoEndpoint / getTivanEndpoint, never via review-web", () => {
    const externalClient = readFileSync(
      path.join(GRAPHQL_LIB_DIR, "external-client.ts"),
      "utf8",
    );
    expect(externalClient).toMatch(/getGigantoEndpoint/);
    expect(externalClient).toMatch(/getTivanEndpoint/);
    // Must not call the default `graphqlRequest` (which targets review-web).
    const stripped = stripTsComments(externalClient);
    expect(stripped).not.toMatch(/\bgraphqlRequest\s*\(/);
  });
});
