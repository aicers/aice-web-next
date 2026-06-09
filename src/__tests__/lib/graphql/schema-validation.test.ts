import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSchema, type GraphQLSchema, parse, validate } from "graphql";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/review.graphql");
const VERSION_PATH = path.join(REPO_ROOT, "schemas/review.version");
const GIGANTO_SCHEMA_PATH = path.join(REPO_ROOT, "schemas/giganto.graphql");
const GIGANTO_VERSION_PATH = path.join(REPO_ROOT, "schemas/giganto.version");
const TIVAN_SCHEMA_PATH = path.join(REPO_ROOT, "schemas/tivan.graphql");
const TIVAN_VERSION_PATH = path.join(REPO_ROOT, "schemas/tivan.version");
const QUERY_ROOT = path.join(REPO_ROOT, "src");

/**
 * Per-SDL routing for `.graphql` files under `src/lib/`.
 *
 * Manager queries validate against `schemas/review.graphql`; Giganto
 * queries against `schemas/giganto.graphql`; Tivan queries against
 * `schemas/tivan.graphql`. A document validated against the wrong SDL
 * must fail — this is the contract the per-service direct-dispatch
 * design relies on.
 *
 * Two conventions route a document to Giganto:
 *
 *   - The mixed-target `src/lib/node/queries/external/` directory holds
 *     Giganto **and** Tivan per-service `status` / `config` documents in
 *     one place, so routing there keys off the `giganto-` / `tivan-`
 *     filename prefix.
 *   - The `src/lib/event/queries/` directory is wholly Giganto (the
 *     Event-menu source-event browsing surface), so the entire tree
 *     routes to the Giganto SDL by path — no per-file prefix needed.
 *
 * Inline GraphQL in TypeScript sources is unconditionally validated
 * against the manager SDL, since the only inline-parse() callers in
 * the repo are Detection / Triage / Node-management server actions
 * that target review-web. External-service queries live in `.graphql`
 * files (never inline) so the path-based routing below picks them up.
 */
function pickSchemaForQueryFile(
  doc: string,
  schemas: {
    review: GraphQLSchema;
    giganto: GraphQLSchema;
    tivan: GraphQLSchema;
  },
): { schema: GraphQLSchema; sdl: string } {
  const rel = path.relative(REPO_ROOT, doc);
  const base = path.basename(doc);
  if (rel.startsWith("src/lib/event/queries/")) {
    return { schema: schemas.giganto, sdl: "schemas/giganto.graphql" };
  }
  if (rel.startsWith("src/lib/node/queries/external/")) {
    if (base.startsWith("giganto-"))
      return { schema: schemas.giganto, sdl: "schemas/giganto.graphql" };
    if (base.startsWith("tivan-"))
      return { schema: schemas.tivan, sdl: "schemas/tivan.graphql" };
  }
  return { schema: schemas.review, sdl: "schemas/review.graphql" };
}
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tests__",
  "__integration__",
  "test-harness",
]);

// Known module specifiers that export a `gql` tag producing a GraphQL
// document. Template literals tagged with identifiers imported from these
// modules are treated as runtime GraphQL.
const GQL_TAG_MODULES = new Set([
  "graphql-tag",
  "graphql-request",
  "@apollo/client",
  "@apollo/client/core",
  "@urql/core",
  "urql",
  "graphql",
]);

function loadSchema(): GraphQLSchema {
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  return buildSchema(sdl);
}

function loadGigantoSchema(): GraphQLSchema {
  const sdl = readFileSync(GIGANTO_SCHEMA_PATH, "utf8");
  return buildSchema(sdl);
}

function loadTivanSchema(): GraphQLSchema {
  const sdl = readFileSync(TIVAN_SCHEMA_PATH, "utf8");
  return buildSchema(sdl);
}

function walk(root: string, match: (name: string) => boolean): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && match(entry.name)) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function findQueryDocuments(root: string): string[] {
  return walk(
    root,
    (name) => name.endsWith(".graphql") || name.endsWith(".gql"),
  );
}

/**
 * Operation files declare fragment dependencies via a leading
 * `# requires: <relative-path>` header line. The runtime composes
 * referenced files into a single document at parse time
 * (`src/lib/node/queries.ts`); the schema-validation test mirrors
 * that composition so a fragment shared between multiple operations
 * (e.g. `node-fields.graphql`) lives in exactly one file and validates
 * once via the composed document. Fragment-only partials are skipped
 * from standalone validation — `NoUnusedFragmentsRule` would otherwise
 * reject them — and their correctness is enforced through every
 * operation that requires them.
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

function resolveDependencies(filePath: string): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (p: string): void => {
    const key = path.resolve(p);
    if (visited.has(key)) return;
    visited.add(key);
    const source = readFileSync(p, "utf8");
    for (const req of readRequires(source)) {
      visit(path.resolve(path.dirname(p), req));
    }
    order.push(p);
  };
  visit(filePath);
  return order;
}

function composeQueryDocument(filePath: string): string {
  return resolveDependencies(filePath)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

function collectPartialPaths(roots: string[]): Set<string> {
  const partials = new Set<string>();
  for (const root of roots) {
    const source = readFileSync(root, "utf8");
    for (const req of readRequires(source)) {
      partials.add(path.resolve(path.dirname(root), req));
    }
  }
  return partials;
}

function findSourceFiles(root: string): string[] {
  return walk(
    root,
    (name) =>
      name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts"),
  );
}

/**
 * Files that legitimately call `parse(fs.readFileSync(...))` to load
 * a checked-in `.graphql` document at module init. These callers are
 * exempt from the "dynamic GraphQL construction" rule because their
 * input is a static, checked-in file — already validated against the
 * correct SDL by the per-SDL `.graphql` walking test above. The
 * runtime hazard the rule guards against is interpolating user input
 * or runtime-assembled strings into a query, which is not what these
 * loaders do.
 */
const STATIC_QUERY_LOADERS = new Set<string>([
  "src/lib/node/queries.ts",
  "src/lib/triage/queries.ts",
  "src/lib/event/queries.ts",
  "src/lib/event/review-queries.ts",
]);

interface StaticDoc {
  text: string;
  line: number;
}

interface DynamicSite {
  line: number;
  kind:
    | "interpolated gql template"
    | "parse() with non-literal argument"
    | "graphql.parse() with non-literal argument";
}

// Collects GraphQL documents embedded in a TypeScript source file by walking
// the AST. Detection is scoped to call/tag sites that actually produce GraphQL:
//
//   - `gql`…`` tagged templates, where `gql` is imported from a known GraphQL
//     package (graphql-tag, @apollo/client, graphql-request, etc.). Aliases
//     like `import { gql as graphqlTag } from "graphql-tag"` are supported.
//   - `parse("…")` / `parse(`…`)` calls, where `parse` is imported from
//     `graphql`. Also supports `import * as graphql from "graphql"` with
//     `graphql.parse("…")` call sites.
//
// Sites that can't be statically validated — interpolated `gql` templates and
// `parse(variable)` calls — are reported as dynamic sites. They would otherwise
// produce a `DocumentNode` that slips past both the schema-validation check and
// the `DocumentNode`-only runtime guard in `graphqlRequest`. CI fails on any
// dynamic site so every production GraphQL document is statically discoverable.
//
// This intentionally avoids matching arbitrary string literals that happen to
// start with `query` / `mutation` / etc., which would flag unrelated code
// such as `JSON.parse("query parameter")` or UI label strings.
function extractInlineGraphql(
  filePath: string,
  source: string,
): { documents: StaticDoc[]; dynamicSites: DynamicSite[] } {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // Local identifier -> which import it refers to.
  const gqlTagNames = new Set<string>();
  const parseNames = new Set<string>();
  const graphqlNamespaces = new Set<string>();

  const collectImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause
    ) {
      const spec = node.moduleSpecifier.text;
      const bindings = node.importClause.namedBindings;
      if (bindings) {
        if (ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            const local = el.name.text;
            if (imported === "gql" && GQL_TAG_MODULES.has(spec)) {
              gqlTagNames.add(local);
            }
            if (imported === "parse" && spec === "graphql") {
              parseNames.add(local);
            }
          }
        } else if (ts.isNamespaceImport(bindings) && spec === "graphql") {
          graphqlNamespaces.add(bindings.name.text);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(sf);

  const getLine = (pos: number): number =>
    ts.getLineAndCharacterOfPosition(sf, pos).line + 1;

  const isStaticStringArg = (
    arg: ts.Expression,
  ): { text: string } | undefined => {
    if (ts.isStringLiteralLike(arg)) return { text: arg.text };
    if (ts.isNoSubstitutionTemplateLiteral(arg)) return { text: arg.text };
    return undefined;
  };

  const documents: StaticDoc[] = [];
  const dynamicSites: DynamicSite[] = [];

  const visit = (node: ts.Node): void => {
    // gql`…` tagged templates. Static literals are validated; templates with
    // interpolations can't be validated statically, so they are reported as
    // dynamic sites and fail CI.
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      gqlTagNames.has(node.tag.text)
    ) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        documents.push({
          text: node.template.text,
          line: getLine(node.template.getStart(sf)),
        });
      } else {
        dynamicSites.push({
          line: getLine(node.template.getStart(sf)),
          kind: "interpolated gql template",
        });
      }
    }

    // parse("…") where `parse` is the named import from "graphql".
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      parseNames.has(node.expression.text) &&
      node.arguments.length > 0
    ) {
      const match = isStaticStringArg(node.arguments[0]);
      if (match) {
        documents.push({
          text: match.text,
          line: getLine(node.arguments[0].pos),
        });
      } else {
        dynamicSites.push({
          line: getLine(node.arguments[0].pos),
          kind: "parse() with non-literal argument",
        });
      }
    }

    // `graphql.parse("…")` via `import * as graphql from "graphql"`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      graphqlNamespaces.has(node.expression.expression.text) &&
      node.expression.name.text === "parse" &&
      node.arguments.length > 0
    ) {
      const match = isStaticStringArg(node.arguments[0]);
      if (match) {
        documents.push({
          text: match.text,
          line: getLine(node.arguments[0].pos),
        });
      } else {
        dynamicSites.push({
          line: getLine(node.arguments[0].pos),
          kind: "graphql.parse() with non-literal argument",
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { documents, dynamicSites };
}

// Validates a checked-in `.graphql` / `.gql` document against the vendored
// schema using the same code path as the main walking test, so a regression
// test can feed a malformed fixture through the real harness.
function validateQueryDocumentSource(
  rel: string,
  source: string,
  schema: GraphQLSchema,
  sdlName = "schemas/review.graphql",
): string | null {
  let document: ReturnType<typeof parse>;
  try {
    document = parse(source, { noLocation: false });
  } catch (err) {
    return `GraphQL parse failed for ${rel}: ${(err as Error).message}`;
  }
  const errors = validate(schema, document);
  if (errors.length === 0) return null;
  const message = errors.map((e) => `  - ${e.message}`).join("\n");
  return (
    `GraphQL validation failed for ${rel} (SDL: ${sdlName}):\n${message}\n\n` +
    `If the upstream schema has changed, update ${sdlName} (and its ` +
    "sibling .version file) together in the same PR. See the " +
    '"Backend schema versions" section of README.md for the procedure.'
  );
}

// Runs the full inline-GraphQL harness on a single source: AST walk +
// per-document parse/validate + dynamic-site rejection. Shared between the
// repo-wide walking test and the negative-path regression tests so a broken
// collector (empty `documents` / missing `dynamicSites`) would surface
// immediately.
function validateInlineSource(
  rel: string,
  filePath: string,
  source: string,
  schema: GraphQLSchema,
): string[] {
  const failures: string[] = [];
  const { documents, dynamicSites } = extractInlineGraphql(filePath, source);
  for (const { text, line } of documents) {
    let document: ReturnType<typeof parse>;
    try {
      document = parse(text);
    } catch (err) {
      failures.push(
        `${rel}:${line} failed to parse as GraphQL: ${(err as Error).message}`,
      );
      continue;
    }
    const errors = validate(schema, document);
    if (errors.length > 0) {
      const message = errors.map((e) => `  - ${e.message}`).join("\n");
      failures.push(`${rel}:${line} validation failed:\n${message}`);
    }
  }
  for (const { line, kind } of dynamicSites) {
    failures.push(
      `${rel}:${line} dynamic GraphQL construction (${kind}) is not ` +
        "allowed: the document cannot be statically validated against " +
        "schemas/review.graphql. Inline the query as a string literal " +
        "or checked-in .graphql file so CI can validate it.",
    );
  }
  return failures;
}

describe("vendored REview GraphQL schema", () => {
  it("schemas/review.graphql parses as a valid SDL", () => {
    expect(() => loadSchema()).not.toThrow();
  });

  it("schemas/review.version is present and non-empty", () => {
    const content = readFileSync(VERSION_PATH, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
  });

  it("schemas/giganto.graphql parses as a valid SDL", () => {
    expect(() => loadGigantoSchema()).not.toThrow();
  });

  it("schemas/giganto.version is present and non-empty", () => {
    const content = readFileSync(GIGANTO_VERSION_PATH, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
  });

  it("schemas/tivan.graphql parses as a valid SDL", () => {
    expect(() => loadTivanSchema()).not.toThrow();
  });

  it("schemas/tivan.version is present and non-empty", () => {
    const content = readFileSync(TIVAN_VERSION_PATH, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
  });

  const schema = loadSchema();
  const gigantoSchema = loadGigantoSchema();
  const tivanSchema = loadTivanSchema();
  const schemas = {
    review: schema,
    giganto: gigantoSchema,
    tivan: tivanSchema,
  };
  const documents = findQueryDocuments(QUERY_ROOT);
  const partialPaths = collectPartialPaths(documents);
  const operationDocuments = documents.filter(
    (doc) => !partialPaths.has(path.resolve(doc)),
  );

  if (operationDocuments.length === 0) {
    it("no runtime GraphQL query documents to validate (yet)", () => {
      expect(operationDocuments).toEqual([]);
    });
  } else {
    describe.each(operationDocuments)("query document", (doc) => {
      const rel = path.relative(REPO_ROOT, doc);
      const { schema: target, sdl } = pickSchemaForQueryFile(doc, schemas);
      it(`validates ${rel} against ${sdl}`, () => {
        const source = composeQueryDocument(doc);
        const failure = validateQueryDocumentSource(rel, source, target, sdl);
        if (failure) throw new Error(failure);
      });
    });
  }

  it("validates inline GraphQL documents in TypeScript sources against the manager SDL", () => {
    // Inline GraphQL in `.ts` / `.tsx` is unconditionally manager-bound:
    // the only inline-parse callers in the repo are review-web targets.
    // External-service queries live in `.graphql` files (per-SDL routed
    // above), so a stray external query inlined in TypeScript would fail
    // here against `schemas/review.graphql` — which is the right
    // outcome.
    const failures: string[] = [];
    for (const file of findSourceFiles(QUERY_ROOT)) {
      const rel = path.relative(REPO_ROOT, file);
      if (STATIC_QUERY_LOADERS.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      failures.push(...validateInlineSource(rel, file, source, schema));
    }
    if (failures.length > 0) {
      throw new Error(
        "Inline GraphQL in TypeScript sources failed schema validation:\n\n" +
          failures.join("\n\n") +
          '\n\nSee README.md "Backend schema versions" for the update ' +
          "procedure.",
      );
    }
  });

  it("a Giganto query validated against the manager SDL fails (negative path)", () => {
    // A Giganto-only query like `status { diskUsedBytes }` references
    // a type / field that does not exist on review-web, so routing it
    // against the wrong SDL must fail validation. This guards against
    // a regression that would silently widen the manager SDL with
    // external-service fields, or that would accidentally route an
    // external query through the manager bucket.
    const gigantoQuery = "query { status { name diskUsedBytes } }";
    const errors = validate(schema, parse(gigantoQuery));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("a manager query validated against the Giganto SDL fails (negative path)", () => {
    const managerQuery = "query { nodeList { totalCount } }";
    const errors = validate(gigantoSchema, parse(managerQuery));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("a Tivan query validated against the Giganto SDL fails (negative path)", () => {
    // Tivan exposes the ATT&CK-matrices surface (`matrices`,
    // `detailTactics`, etc.) that Giganto does not. A query that
    // selects `matrices { tacticsData { id } }` validates against
    // Tivan but fails against Giganto, so cross-routing is detected.
    const tivanQuery =
      "query { matrices { tacticsData { id } childTechniques { id } } }";
    expect(validate(tivanSchema, parse(tivanQuery)).length).toBe(0);
    expect(validate(gigantoSchema, parse(tivanQuery)).length).toBeGreaterThan(
      0,
    );
  });

  it("rejects a malformed inline query through the collector+validator harness", () => {
    // Route a synthetic TS source containing a malformed GraphQL document
    // through the same AST walk + validator the repo-wide test uses. This
    // exercises `extractInlineGraphql` -> parse -> `validate` end-to-end, so
    // a regression that causes the collector to stop finding inline queries
    // (e.g. dropped tag module, broken import tracking) would make this test
    // pass silently without this pipeline check.
    const fakeFile = "/virtual/malformed-inline.ts";
    const source = [
      'import { parse } from "graphql";',
      'const doc = parse("query { __typename fieldThatDoesNotExist }");',
      "void doc;",
    ].join("\n");
    const failures = validateInlineSource(
      "virtual/malformed-inline.ts",
      fakeFile,
      source,
      schema,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/fieldThatDoesNotExist/);
    expect(failures[0]).toMatch(/validation failed/);
  });

  it("rejects a malformed .graphql fixture through findQueryDocuments + validator", () => {
    // Drop a malformed .graphql file into a temp directory, run the real
    // findQueryDocuments collector over that directory, and then feed the
    // result through the same parse+validate helper the repo-wide test uses.
    // This exercises the full checked-in-document path end-to-end, so a
    // regression that broke findQueryDocuments (e.g. wrong extension filter,
    // broken directory walk) would surface here instead of silently skipping.
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "schema-validation-"));
    try {
      const fixturePath = path.join(tmpRoot, "malformed.graphql");
      writeFileSync(
        fixturePath,
        "query { __typename fieldThatDoesNotExist }\n",
        "utf8",
      );
      const collected = findQueryDocuments(tmpRoot);
      expect(collected).toEqual([fixturePath]);
      const failures: string[] = [];
      for (const doc of collected) {
        const rel = path.relative(tmpRoot, doc);
        const source = readFileSync(doc, "utf8");
        const failure = validateQueryDocumentSource(rel, source, schema);
        if (failure) failures.push(failure);
      }
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/fieldThatDoesNotExist/);
      expect(failures[0]).toMatch(/SDL: schemas\/review\.graphql/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("flags dynamic GraphQL construction as an unvalidatable site", () => {
    // Non-literal parse(variable) would produce a DocumentNode that slips
    // past both the .graphql validator and the DocumentNode-only runtime
    // guard in graphqlRequest, so the AST walk must report it.
    // Keep the fixture as concatenated fragments so the `${...}` inside the
    // test-source literal is not picked up by the outer template rule.
    const dollar = "$";
    const fakeFile = "/virtual/dynamic.ts";
    const source = [
      'import { parse } from "graphql";',
      'import { gql } from "graphql-tag";',
      'const text = "query { fieldThatDoesNotExist }";',
      "const a = parse(text);",
      "const field = `fieldThatDoesNotExist`;",
      `const b = gql\`query { ${dollar}{field} }\`;`,
      "const c = parse(`query { __typename }`);",
      "void a; void b; void c;",
    ].join("\n");
    const { documents, dynamicSites } = extractInlineGraphql(fakeFile, source);

    expect(documents.map((d) => d.text.trim())).toEqual([
      "query { __typename }",
    ]);
    const kinds = dynamicSites.map((s) => s.kind).sort();
    expect(kinds).toEqual([
      "interpolated gql template",
      "parse() with non-literal argument",
    ]);
  });
});
