import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  type DocumentNode,
  type ExecutionResult,
  execute,
  type FragmentDefinitionNode,
  type GraphQLError,
  type GraphQLSchema,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  validate,
} from "graphql";

import { type FixtureSchemaName, loadReviewSchema, loadSchema } from "./schema";

const FIXTURES_ROOT = resolve(__dirname, "../__tests__/fixtures");
const MANIFEST_FILES: Record<FixtureSchemaName, string> = {
  review: "manifest.json",
  giganto: "manifest.giganto.json",
  tivan: "manifest.tivan.json",
};
const COVERAGE_PREFIXES: Record<FixtureSchemaName, readonly string[]> = {
  review: ["detection/", "node/"],
  giganto: ["external/giganto/"],
  tivan: ["external/tivan/"],
};

export interface FixtureManifestEntry {
  /** Operation name (matches the field on Query/Mutation root). */
  operation: string;
  /** Path to the fixture JSON, relative to `src/__tests__/fixtures/`. */
  fixture: string;
  /** Path to the GraphQL document the fixture is paired with (relative). */
  query: string;
  /**
   * Variables passed to `graphql.execute()` for fixture validation, and —
   * because an empty/absent value is collapsed to a catch-all runtime
   * matcher — doubles as the stub matcher at request time. Multiple
   * manifest entries for the same operation can coexist as long as their
   * `variables` shapes differ (subset JSON-equality per key).
   *
   * A catch-all manifest entry (omitted or empty `variables`) is only
   * valid when the paired query declares no required variables. If the
   * query has any non-null variable without a default, concrete values
   * are mandatory here — there is no "skip validation" path, because
   * `graphql.execute()` needs a value for every required variable.
   * Preflight rejects this combination with a clear error. For
   * scenario-level catch-all behaviour on such operations, register via
   * the admin endpoint at request time.
   */
  variables?: Record<string, unknown>;
}

export interface FixtureManifestOptions {
  schemaName?: FixtureSchemaName;
}

function manifestPath(schemaName: FixtureSchemaName): string {
  return resolve(FIXTURES_ROOT, MANIFEST_FILES[schemaName]);
}

function shouldCheckManifestPath(
  relPath: string,
  schemaName: FixtureSchemaName,
): boolean {
  if (relPath === MANIFEST_FILES[schemaName]) return false;
  return COVERAGE_PREFIXES[schemaName].some((prefix) =>
    relPath.startsWith(prefix),
  );
}

export function fixturesRoot(): string {
  return FIXTURES_ROOT;
}

export function loadFixtureJson(relPath: string): unknown {
  const full = resolve(FIXTURES_ROOT, relPath);
  return JSON.parse(readFileSync(full, "utf8"));
}

export function loadQueryDocument(relPath: string): DocumentNode {
  const full = resolve(FIXTURES_ROOT, relPath);
  return parse(readFileSync(full, "utf8"));
}

/**
 * Run `query` against the vendored REview schema using `fixture` as the
 * resolver root value. The schema's runtime type-checks act as the validator:
 * shape mismatches (non-null violations, scalar coercion failures, unknown
 * fields) surface as `GraphQLError`s.
 */
export function executeFixture(
  document: DocumentNode,
  fixture: unknown,
  variables: Record<string, unknown> = {},
  schema: GraphQLSchema = loadReviewSchema(),
): ExecutionResult {
  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }
  return execute({
    schema,
    document,
    rootValue: fixture,
    variableValues: variables,
  }) as ExecutionResult;
}

export function describeFailure(
  rel: string,
  result: ExecutionResult,
): string | null {
  const errors: readonly GraphQLError[] = result.errors ?? [];
  if (errors.length === 0) return null;
  return (
    `Fixture ${rel} failed schema-backed execution:\n` +
    errors.map((e) => `  - ${e.message}`).join("\n")
  );
}

/**
 * Validate every fixture declared in the manifest against the vendored
 * schema. Used by the pre-test hook so fixtures break fast at startup
 * rather than mid-test.
 */
export function validateManifest(
  manifest: readonly FixtureManifestEntry[],
  schema: GraphQLSchema = loadReviewSchema(),
): string[] {
  const failures: string[] = [];
  for (const entry of manifest) {
    let document: DocumentNode;
    try {
      document = loadQueryDocument(entry.query);
    } catch (err) {
      failures.push(
        `Fixture ${entry.fixture}: failed to load query ${entry.query}: ` +
          `${(err as Error).message}`,
      );
      continue;
    }
    let fixture: unknown;
    try {
      fixture = loadFixtureJson(entry.fixture);
    } catch (err) {
      failures.push(
        `Fixture ${entry.fixture}: failed to read JSON: ` +
          `${(err as Error).message}`,
      );
      continue;
    }
    const result = executeFixture(
      document,
      fixture,
      entry.variables ?? {},
      schema,
    );
    const failure = describeFailure(entry.fixture, result);
    if (failure) failures.push(failure);
  }
  return failures;
}

export function readManifest(): FixtureManifestEntry[] {
  return readManifestForSchema("review");
}

export function readManifestForSchema(
  schemaName: FixtureSchemaName,
): FixtureManifestEntry[] {
  const fullPath = manifestPath(schemaName);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Fixture manifest at ${fullPath} must be a JSON array.`);
  }
  return raw as FixtureManifestEntry[];
}

export function listFixtureFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [resolve(FIXTURES_ROOT, dir)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Deliberately-invalid fixtures live next to the valid ones — the malformed
 * JSON file is what the validator-rejection unit test loads, so it must not
 * appear in the manifest. Any file whose basename ends with `.malformed.json`
 * (or `.malformed.graphql`) is allowed to exist outside the manifest and
 * bypasses the coverage check.
 */
function isNegativeFixture(relPath: string): boolean {
  const base = relPath.split(/[\\/]/).pop() ?? relPath;
  return /\.malformed\.(json|graphql)$/.test(base);
}

function listFixtureFilesByExt(ext: ".json" | ".graphql"): string[] {
  const out: string[] = [];
  const stack: string[] = [FIXTURES_ROOT];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function toPosixRel(full: string): string {
  return relative(FIXTURES_ROOT, full).split(sep).join("/");
}

/**
 * Verify that every `.json` fixture and `.graphql` document under
 * `src/__tests__/fixtures/` is declared in the manifest. Files ending in
 * `.malformed.json` / `.malformed.graphql` are treated as negative-path
 * fixtures and allowed to exist outside the manifest.
 *
 * Without this check, an author could add a fixture JSON, register it at
 * runtime via `{ kind: "fixture", fixture: "<path>" }` against
 * `/__admin/stubs`, and never run it through the pre-test schema validator
 * — which would defeat issue #296's "all fixtures validate before tests
 * run" requirement.
 */
export function checkManifestCoverage(
  manifest: readonly FixtureManifestEntry[],
  options: FixtureManifestOptions = {},
): string[] {
  const schemaName = options.schemaName ?? "review";
  const manifestFile = MANIFEST_FILES[schemaName];
  const failures: string[] = [];
  const declaredFixtures = new Set<string>();
  const declaredQueries = new Set<string>();
  for (const entry of manifest) {
    declaredFixtures.add(entry.fixture);
    declaredQueries.add(entry.query);
  }

  for (const full of listFixtureFilesByExt(".json")) {
    const rel = toPosixRel(full);
    if (!shouldCheckManifestPath(rel, schemaName)) continue;
    if (isNegativeFixture(rel)) continue;
    if (!declaredFixtures.has(rel)) {
      failures.push(
        `Fixture ${rel} is not declared in ${manifestFile}. Every JSON ` +
          "fixture must have a manifest entry so the pre-test hook validates " +
          `it against schemas/${schemaName}.graphql. Deliberately-invalid fixtures ` +
          "must use the `.malformed.json` suffix.",
      );
    }
  }

  for (const full of listFixtureFilesByExt(".graphql")) {
    const rel = toPosixRel(full);
    if (!shouldCheckManifestPath(rel, schemaName)) continue;
    if (isNegativeFixture(rel)) continue;
    if (!declaredQueries.has(rel)) {
      failures.push(
        `Query document ${rel} is not referenced by any manifest entry. ` +
          `Every .graphql document must be paired with a fixture in ${manifestFile}.`,
      );
    }
  }

  return failures;
}

/**
 * Collect every top-level field name an operation would select, following
 * `FragmentSpread` and `InlineFragment` selections on the operation's root
 * selection set. The mock-server router and the preflight consistency check
 * both funnel through this helper so a document written with fragments
 * (`query Q { ...RootFields }`) resolves to the same root fields as one with
 * inline selections. Fragment spreads that do not resolve to a definition in
 * the same document, or that form cycles, are skipped — `validate()` already
 * rejects those upstream.
 */
export function extractRootFieldNames(document: DocumentNode): string[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === "FragmentDefinition") {
      fragments.set(def.name.value, def);
    }
  }
  const opDef = document.definitions.find(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  if (!opDef) return [];

  const fields: string[] = [];
  const visited = new Set<string>();
  const walk = (selectionSet: SelectionSetNode): void => {
    for (const sel of selectionSet.selections) {
      if (sel.kind === "Field") {
        fields.push(sel.name.value);
      } else if (sel.kind === "InlineFragment") {
        walk(sel.selectionSet);
      } else if (sel.kind === "FragmentSpread") {
        const name = sel.name.value;
        if (visited.has(name)) continue;
        visited.add(name);
        const frag = fragments.get(name);
        if (frag) walk(frag.selectionSet);
      }
    }
  };
  walk(opDef.selectionSet);
  return fields;
}

/**
 * Verify that each manifest entry's metadata is internally consistent:
 *
 * - `entry.operation` must match a top-level field selected by the
 *   query document. `preloadManifestStubs()` keys the runtime registry
 *   off `entry.operation`, so a typo there silently produces a
 *   `no stub registered` error at request time instead of failing
 *   preflight.
 * - The fixture JSON (when it is an object) must own a top-level key
 *   equal to `entry.operation`, even when its value is intentionally
 *   `null`. Without this check, a mis-keyed fixture against a nullable
 *   root (e.g. `trafficFilterList: [TrafficFilter!]`) resolves quietly
 *   to `null` under `graphql.execute()` because the requested key is
 *   absent from the root value — preflight would pass and the test
 *   would see an unexpected null.
 *
 * This check runs before `validateManifest()` so the metadata problem
 * surfaces with a clearer message than the downstream GraphQL error.
 */
export function checkManifestConsistency(
  manifest: readonly FixtureManifestEntry[],
): string[] {
  const failures: string[] = [];
  for (const entry of manifest) {
    let document: DocumentNode;
    try {
      document = loadQueryDocument(entry.query);
    } catch {
      // Load failures are reported by validateManifest; don't double-report.
      continue;
    }
    const topLevelFields = extractRootFieldNames(document);
    if (topLevelFields.length === 0) {
      failures.push(
        `Manifest entry for ${entry.fixture}: query ${entry.query} has no ` +
          "top-level field selections.",
      );
      continue;
    }
    if (!topLevelFields.includes(entry.operation)) {
      failures.push(
        `Manifest entry for ${entry.fixture}: operation '${entry.operation}' ` +
          `does not match any root field in ${entry.query} ` +
          `(selects ${topLevelFields.map((f) => `'${f}'`).join(", ")}).`,
      );
      continue;
    }

    let fixture: unknown;
    try {
      fixture = loadFixtureJson(entry.fixture);
    } catch {
      // Load failures are reported by validateManifest; don't double-report.
      continue;
    }
    if (
      typeof fixture !== "object" ||
      fixture === null ||
      Array.isArray(fixture)
    ) {
      failures.push(
        `Manifest entry for ${entry.fixture}: fixture must be a JSON object ` +
          `with a top-level '${entry.operation}' key.`,
      );
      continue;
    }
    if (!Object.hasOwn(fixture as Record<string, unknown>, entry.operation)) {
      failures.push(
        `Manifest entry for ${entry.fixture}: fixture is missing the ` +
          `top-level '${entry.operation}' key required by the manifest. ` +
          "If the response is intentionally null, set the key explicitly " +
          `to null (\`{ "${entry.operation}": null }\`).`,
      );
    }
  }
  return failures;
}

/**
 * Flag manifest entries that advertise catch-all matcher semantics (no
 * `variables` or `variables: {}`) but pair them with a query document
 * that declares required variables. `graphql.execute()` needs a value
 * for every non-null variable, so such entries would otherwise fail
 * preflight with a cryptic `Variable "$foo" of required type "X!" was
 * not provided` error. This check surfaces the real cause — a catch-all
 * manifest entry is only valid when the paired query has no required
 * variables — and points authors at the admin endpoint for
 * scenario-level catch-alls on operations that do take required inputs.
 */
export function checkManifestCatchAllSafety(
  manifest: readonly FixtureManifestEntry[],
): string[] {
  const failures: string[] = [];
  for (const entry of manifest) {
    const vars = entry.variables;
    if (vars && Object.keys(vars).length > 0) continue;
    let document: DocumentNode;
    try {
      document = loadQueryDocument(entry.query);
    } catch {
      // Load failures are reported by validateManifest.
      continue;
    }
    const missing: string[] = [];
    for (const def of document.definitions) {
      if (def.kind !== "OperationDefinition") continue;
      for (const varDef of def.variableDefinitions ?? []) {
        if (
          varDef.type.kind === "NonNullType" &&
          varDef.defaultValue === undefined
        ) {
          missing.push(varDef.variable.name.value);
        }
      }
    }
    if (missing.length === 0) continue;
    const plural = missing.length > 1 ? "s" : "";
    failures.push(
      `Manifest entry for ${entry.fixture}: query ${entry.query} declares ` +
        `required variable${plural} ${missing
          .map((v) => `$${v}`)
          .join(", ")} but the entry has no \`variables\`. Catch-all ` +
        "manifest entries are only valid when the paired query has no " +
        "required variables; otherwise `graphql.execute()` cannot validate " +
        "the fixture. Provide concrete values here (they double as the " +
        "runtime matcher), or register a scenario-level catch-all at " +
        "request time via /__admin/stubs.",
    );
  }
  return failures;
}

/**
 * Stable JSON serialization with keys sorted at every object level. Two
 * manifest entries produce the same runtime matcher when their
 * `(operation, variables)` canonicalize to the same string — including the
 * trivial case where both omit `variables` (both collapse to the catch-all
 * tier). The specificity-first resolver makes last-registered-wins within a
 * tier, so a silent duplicate would let manifest order decide which fixture
 * wins. This canonicalization is what `checkManifestDuplicates()` hashes on,
 * and it is also what the runtime matcher in `StubRegistry.resolve()` uses
 * to compare variable values — otherwise preflight (which deep-sorts keys)
 * and request-time matching (which preserves construction order) would
 * disagree for object-shaped filter variables like REview's `$filter`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

interface NormalizedMatcher {
  /** Canonical JSON of each key's value (keys sorted). */
  values: Record<string, string>;
  keys: string[];
}

function normalizeManifestMatcher(
  vars: Record<string, unknown> | undefined,
): NormalizedMatcher | null {
  if (!vars || Object.keys(vars).length === 0) return null;
  const entries = Object.entries(vars).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const values: Record<string, string> = {};
  const keys: string[] = [];
  for (const [k, v] of entries) {
    keys.push(k);
    values[k] = canonicalJson(v);
  }
  return { values, keys };
}

function matchersEqual(a: NormalizedMatcher, b: NormalizedMatcher): boolean {
  if (a.keys.length !== b.keys.length) return false;
  for (const k of a.keys) {
    if (a.values[k] !== b.values[k]) return false;
  }
  return true;
}

function matcherIsSubset(
  sub: NormalizedMatcher,
  sup: NormalizedMatcher,
): boolean {
  for (const k of sub.keys) {
    if (!Object.hasOwn(sup.values, k)) return false;
    if (sub.values[k] !== sup.values[k]) return false;
  }
  return true;
}

function matchersCanBothMatch(
  a: NormalizedMatcher,
  b: NormalizedMatcher,
): boolean {
  // Both are satisfied by some request only when they agree on every shared
  // key; the disjoint keys of each matcher are then simply added by that
  // request. A disagreement on a shared key means no single request can
  // satisfy both simultaneously.
  for (const k of a.keys) {
    if (Object.hasOwn(b.values, k) && a.values[k] !== b.values[k]) {
      return false;
    }
  }
  return true;
}

function describeMatcher(entry: FixtureManifestEntry): string {
  const key = normalizeManifestMatcher(entry.variables);
  if (!key) return "catch-all (no/empty `variables`)";
  const body = key.keys
    .map((k) => `${JSON.stringify(k)}:${key.values[k]}`)
    .join(",");
  return `variables shape {${body}}`;
}

/**
 * Reject manifest entries whose matchers would leave the live registry
 * order-dependent.
 *
 * `preloadManifestStubs()` loads every entry into `StubRegistry` in manifest
 * order. `StubRegistry.resolve()` picks the satisfying specific matcher with
 * the most constrained keys (specificity-first), falling back to last-
 * registered only on ties within a tier. Two flavours of ambiguity need to
 * be caught before they hit that resolver:
 *
 * 1. **Identical matchers.** Two catch-alls for one operation, or two
 *    narrow entries with the same `variables` shape, tie at the top of
 *    their tier — manifest order silently decides which fixture wins.
 *
 * 2. **Overlapping non-subset matchers.** Two entries like `{a:1, b:2}` and
 *    `{a:1, c:3}` have the same key count, don't contradict on shared keys,
 *    and are both satisfied by a request carrying `{a:1, b:2, c:3}`. Neither
 *    is strictly more specific than the other, so specificity-first has a
 *    tie and falls through to registration order. Manifest additions are
 *    supposed to be the safe way to grow fixture inventory, so this case has
 *    to fail preflight too. (A strict-subset overlap — one matcher's keys
 *    are a strict superset of the other's, values agree on shared keys — is
 *    fine: the larger matcher wins deterministically.)
 */
export function checkManifestDuplicates(
  manifest: readonly FixtureManifestEntry[],
): string[] {
  const failures: string[] = [];
  const byOp = new Map<
    string,
    { matcher: NormalizedMatcher | null; entry: FixtureManifestEntry }[]
  >();
  for (const entry of manifest) {
    const list = byOp.get(entry.operation) ?? [];
    list.push({
      matcher: normalizeManifestMatcher(entry.variables),
      entry,
    });
    byOp.set(entry.operation, list);
  }
  for (const [operation, entries] of byOp) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.matcher === null && b.matcher === null) {
          failures.push(
            `Manifest entries ${a.entry.fixture} and ${b.entry.fixture} both ` +
              `register operation '${operation}' with the same catch-all ` +
              "(no/empty `variables`). StubRegistry.resolve() makes " +
              "last-registered-wins within a specificity tier, so manifest " +
              "order would silently decide which fixture answers matching " +
              "requests. Give each entry a distinct `variables` shape, or " +
              "consolidate them into one.",
          );
          continue;
        }
        if (a.matcher === null || b.matcher === null) continue;
        if (matchersEqual(a.matcher, b.matcher)) {
          failures.push(
            `Manifest entries ${a.entry.fixture} and ${b.entry.fixture} both ` +
              `register operation '${operation}' with the same ` +
              `${describeMatcher(a.entry)}. StubRegistry.resolve() makes ` +
              "last-registered-wins within a specificity tier, so manifest " +
              "order would silently decide which fixture answers matching " +
              "requests. Give each entry a distinct `variables` shape, or " +
              "consolidate them into one.",
          );
          continue;
        }
        if (
          matcherIsSubset(a.matcher, b.matcher) ||
          matcherIsSubset(b.matcher, a.matcher)
        ) {
          // Strict subset (differing key counts, values agree on shared
          // keys): the larger matcher is strictly more specific, so
          // specificity-first resolution picks it deterministically.
          continue;
        }
        if (matchersCanBothMatch(a.matcher, b.matcher)) {
          failures.push(
            `Manifest entries ${a.entry.fixture} and ${b.entry.fixture} ` +
              `register overlapping specific matchers for operation ` +
              `'${operation}' (${describeMatcher(a.entry)} vs ` +
              `${describeMatcher(b.entry)}). Neither matcher is a strict ` +
              "superset of the other, so a request matching both would fall " +
              "through specificity-first to registration order. Give one " +
              "entry additional keys so it is a strict superset of the " +
              "other (specificity-first will then pick it deterministically), " +
              "or make the matchers disjoint by contradicting on a shared " +
              "key.",
          );
        }
      }
    }
  }
  return failures;
}

/**
 * Full preflight: schema-validate every manifest entry and verify that
 * every fixture/document on disk is covered by the manifest. Call this
 * from both the integration and Playwright globalSetups.
 */
export function runFixturePreflight(
  manifest: readonly FixtureManifestEntry[],
  schema: GraphQLSchema = loadReviewSchema(),
  options: FixtureManifestOptions = {},
): string[] {
  return [
    ...checkManifestCoverage(manifest, options),
    ...checkManifestConsistency(manifest),
    ...checkManifestCatchAllSafety(manifest),
    ...checkManifestDuplicates(manifest),
    ...validateManifest(manifest, schema),
  ];
}

export function readAllFixtureManifests(): Record<
  FixtureSchemaName,
  FixtureManifestEntry[]
> {
  return {
    review: readManifestForSchema("review"),
    giganto: readManifestForSchema("giganto"),
    tivan: readManifestForSchema("tivan"),
  };
}

export function runAllFixturePreflights(): string[] {
  const manifests = readAllFixtureManifests();
  return (
    Object.entries(manifests) as Array<
      [FixtureSchemaName, FixtureManifestEntry[]]
    >
  ).flatMap(([schemaName, manifest]) =>
    runFixturePreflight(manifest, loadSchema(schemaName), { schemaName }),
  );
}
