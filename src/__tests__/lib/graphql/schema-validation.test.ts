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
const QUERY_ROOT = path.join(REPO_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__"]);

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

function findSourceFiles(root: string): string[] {
  return walk(
    root,
    (name) =>
      name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts"),
  );
}

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
    `GraphQL validation failed for ${rel}:\n${message}\n\n` +
    "If REview's schema has changed, update schemas/review.graphql " +
    "and schemas/review.version together in the same PR. See the " +
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

  const schema = loadSchema();
  const documents = findQueryDocuments(QUERY_ROOT);

  if (documents.length === 0) {
    it("no runtime GraphQL query documents to validate (yet)", () => {
      expect(documents).toEqual([]);
    });
  } else {
    describe.each(documents)("query document", (doc) => {
      const rel = path.relative(REPO_ROOT, doc);
      it(`validates ${rel} against schemas/review.graphql`, () => {
        const source = readFileSync(doc, "utf8");
        const failure = validateQueryDocumentSource(rel, source, schema);
        if (failure) throw new Error(failure);
      });
    });
  }

  it("validates inline GraphQL documents in TypeScript sources", () => {
    const failures: string[] = [];
    for (const file of findSourceFiles(QUERY_ROOT)) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file);
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
      expect(failures[0]).toMatch(/schemas\/review\.graphql/);
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
