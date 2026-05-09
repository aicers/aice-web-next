#!/usr/bin/env node
// Generate `src/lib/detection/types.generated.ts` from the vendored
// REview SDL at `schemas/review.graphql`.
//
// The generator emits the subset of schema types the Detection server
// actions consume: scalars, enums, inputs (and their transitive input
// deps), the paging/counter output types, and the `Event` interface's
// common fields (as `EventBase`). A companion Vitest spec runs the
// same `generate()` function in-memory and asserts the output matches
// the checked-in file, so a schema bump that is not reflected in the
// generated TS fails CI.
//
// Run directly with `pnpm codegen:detection`.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const SCHEMA_PATH = path.join(ROOT, "schemas/review.graphql");
const OUT_PATH = path.join(ROOT, "src/lib/detection/types.generated.ts");

// Built-in and custom scalars mapped to TS. Any unmapped scalar
// referenced from the walked graph makes the generator fail loudly.
const SCALAR_MAP = {
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  ID: "IDScalar",
  DateTime: "DateTimeScalar",
  StringNumber: "StringNumberScalar",
};

// Scalars that get a named TS alias in the generated file instead of
// collapsing to `string` at each use site.
const NAMED_SCALAR_ALIASES = [
  [
    "DateTimeScalar",
    "string",
    "`DateTime` scalar; REview serializes it as an ISO-8601 string.",
  ],
  [
    "StringNumberScalar",
    "string",
    "`StringNumber` scalar; REview serializes 64-bit counts as strings to avoid JavaScript number precision loss. Never cast to `number`.",
  ],
  ["IDScalar", "string", "`ID` scalar."],
];

// Roots the generator walks; everything they transitively reference
// is emitted too.
const ROOT_TYPES = [
  "EventListFilterInput",
  "EventConnection",
  "EventEdge",
  "PageInfo",
  "TriageScore",
  "StringEventCounter",
  "ThreatLevelEventCounter",
  "U8EventCounter",
  "Event",
];

/**
 * Render a GraphQL type as a TS type, wrapping for lists and
 * nullability using GraphQL's semantics:
 *   - Non-null `T!` → `T`
 *   - Nullable `T`  → `T | null`
 *   - `[T!]!` → `T[]`, `[T!]` → `T[] | null`,
 *     `[T]!` → `(T | null)[]`, `[T]` → `(T | null)[] | null`.
 */
function renderType(type, used) {
  if (isNonNullType(type)) return renderInner(type.ofType, used);
  return `${renderInner(type, used)} | null`;
}

function renderInner(type, used) {
  if (isListType(type)) {
    const inner = renderType(type.ofType, used);
    const needsParens = inner.includes(" ");
    return `${needsParens ? `(${inner})` : inner}[]`;
  }
  if (isScalarType(type)) {
    const mapped = SCALAR_MAP[type.name];
    if (!mapped) {
      throw new Error(
        `Unmapped scalar "${type.name}" referenced by the generator. ` +
          "Add it to SCALAR_MAP in scripts/codegen-detection-types.mjs.",
      );
    }
    if (
      mapped === "IDScalar" ||
      mapped === "DateTimeScalar" ||
      mapped === "StringNumberScalar"
    ) {
      used.add(mapped);
    }
    return mapped;
  }
  if (isInterfaceType(type)) {
    // Interfaces are emitted as `<Name>Base` (schema-common fields
    // plus `__typename: string`). Narrower discriminated unions over
    // subtypes live in the hand-written `types.ts`.
    const alias = `${type.name}Base`;
    used.add(alias);
    return alias;
  }
  if (isEnumType(type) || isInputObjectType(type) || isObjectType(type)) {
    used.add(type.name);
    return type.name;
  }
  throw new Error(`Unsupported type kind: ${type}`);
}

function collectTransitive(schema, rootNames) {
  const seen = new Map();
  const queue = [...rootNames];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const type = schema.getType(name);
    if (!type) throw new Error(`Type "${name}" not found in schema.`);
    seen.set(name, type);
    if (
      isInputObjectType(type) ||
      isObjectType(type) ||
      isInterfaceType(type)
    ) {
      for (const field of Object.values(type.getFields())) {
        const innerRefs = referencedNamedTypes(field.type);
        for (const refName of innerRefs) queue.push(refName);
      }
    }
  }
  return seen;
}

function referencedNamedTypes(type) {
  const names = [];
  let t = type;
  while (isNonNullType(t) || isListType(t)) t = t.ofType;
  if (
    isEnumType(t) ||
    isInputObjectType(t) ||
    isObjectType(t) ||
    isInterfaceType(t)
  ) {
    names.push(t.name);
  }
  return names;
}

function renderEnum(type) {
  const values = type.getValues().map((v) => `"${v.name}"`);
  const single = `export type ${type.name} = ${values.join(" | ")};`;
  if (single.length <= 80) return single;
  return `export type ${type.name} =\n${values.map((v) => `  | ${v}`).join("\n")};`;
}

function renderFields(type, used, style) {
  const lines = [];
  for (const field of Object.values(type.getFields())) {
    const rendered = renderType(field.type, used);
    if (style === "input") {
      const optional = isNonNullType(field.type) ? "" : "?";
      lines.push(`  ${field.name}${optional}: ${rendered};`);
    } else {
      lines.push(`  ${field.name}: ${rendered};`);
    }
  }
  return lines.join("\n");
}

function renderInputObject(type, used) {
  return `export interface ${type.name} {\n${renderFields(type, used, "input")}\n}`;
}

function renderObject(type, used) {
  return `export interface ${type.name} {\n${renderFields(type, used, "object")}\n}`;
}

function renderInterface(type, used) {
  // Each GraphQL interface is exported as `<Name>Base`: the interface's
  // common fields plus `__typename: string` for runtime dispatch.
  // Hand-written discriminated unions over `<Name>Base & { __typename: "..." }`
  // live in `src/lib/detection/types.ts` for UI use.
  const body = renderFields(type, used, "object");
  return `export interface ${type.name}Base {\n  __typename: string;\n${body}\n}`;
}

export function generate() {
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  const schema = buildSchema(sdl);
  const types = collectTransitive(schema, ROOT_TYPES);
  const used = new Set();

  const enumSources = [];
  const inputSources = [];
  const objectSources = [];
  const interfaceSources = [];

  for (const [name, type] of types) {
    used.add(name);
    if (isEnumType(type)) enumSources.push([name, renderEnum(type)]);
    else if (isInputObjectType(type))
      inputSources.push([name, renderInputObject(type, used)]);
    else if (isInterfaceType(type))
      interfaceSources.push([name, renderInterface(type, used)]);
    else if (isObjectType(type))
      objectSources.push([name, renderObject(type, used)]);
    // Scalars and others are rendered inline via renderType.
  }

  const sortByName = (a, b) => a[0].localeCompare(b[0]);
  enumSources.sort(sortByName);
  inputSources.sort(sortByName);
  objectSources.sort(sortByName);
  interfaceSources.sort(sortByName);

  const header = [
    "// AUTO-GENERATED FROM schemas/review.graphql. DO NOT EDIT.",
    "//",
    "// Regenerate with: pnpm codegen:detection",
    "//",
    "// The generator walks a curated set of roots (see",
    "// scripts/codegen-detection-types.mjs) and emits every",
    "// transitively-referenced type. CI re-runs generation and",
    "// diffs the result against this file, so a schema bump that",
    "// is not reflected here fails fast.",
    "",
  ].join("\n");

  const scalarBlock = NAMED_SCALAR_ALIASES.filter(([name]) => used.has(name))
    .map(
      ([name, target, doc]) =>
        `/** ${doc} */\nexport type ${name} = ${target};`,
    )
    .join("\n\n");

  const sections = [];
  if (scalarBlock) sections.push(`// ── Scalars ──\n\n${scalarBlock}`);
  if (enumSources.length > 0)
    sections.push(
      `// ── Enums ──\n\n${enumSources.map(([, src]) => src).join("\n\n")}`,
    );
  if (inputSources.length > 0)
    sections.push(
      `// ── Inputs ──\n\n${inputSources.map(([, src]) => src).join("\n\n")}`,
    );
  if (interfaceSources.length > 0)
    sections.push(
      `// ── Interfaces (common fields) ──\n\n${interfaceSources.map(([, src]) => src).join("\n\n")}`,
    );
  if (objectSources.length > 0)
    sections.push(
      `// ── Object types ──\n\n${objectSources.map(([, src]) => src).join("\n\n")}`,
    );

  return `${header}\n${sections.join("\n\n")}\n`;
}

function main() {
  const out = generate();
  writeFileSync(OUT_PATH, out, "utf8");
  process.stdout.write(
    `wrote ${path.relative(ROOT, OUT_PATH)} (${out.length} bytes)\n`,
  );
}

const isDirectInvocation =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectInvocation) {
  main();
}
