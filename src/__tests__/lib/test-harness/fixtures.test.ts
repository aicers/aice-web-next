import { resolve } from "node:path";

import { parse } from "graphql";
import { describe, expect, it } from "vitest";

import {
  checkManifestCatchAllSafety,
  checkManifestConsistency,
  checkManifestCoverage,
  checkManifestDuplicates,
  describeFailure,
  executeFixture,
  extractRootFieldNames,
  loadFixtureJson,
  loadQueryDocument,
  readManifest,
  runFixturePreflight,
  validateManifest,
} from "@/test-harness/fixtures";

describe("fixture loader + schema-backed validator", () => {
  it("the manifest validates cleanly against schemas/review.graphql", () => {
    const manifest = readManifest();
    expect(manifest.length).toBeGreaterThan(0);
    const failures = validateManifest(manifest);
    expect(failures).toEqual([]);
  });

  it("rejects a deliberately malformed fixture", () => {
    const document = loadQueryDocument("detection/eventList.empty.graphql");
    const fixture = loadFixtureJson("detection/eventList.malformed.json");
    const result = executeFixture(document, fixture, {
      filter: {},
      first: 10,
    });
    const failure = describeFailure(
      "detection/eventList.malformed.json",
      result,
    );
    expect(failure).not.toBeNull();
    // The malformed fixture sets totalCount=null and pageInfo.hasNextPage to a
    // string. The schema's runtime validator must surface at least one of
    // those, so validateManifest fails fast.
    expect(failure).toMatch(/eventList\.malformed\.json/);
  });

  it("validateManifest surfaces failures from a bad manifest entry", () => {
    const failures = validateManifest([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/eventList.malformed.json",
        variables: { filter: {}, first: 10 },
      },
    ]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/eventList\.malformed\.json/);
  });

  it("checkManifestCoverage passes for the shipped fixtures tree", () => {
    const manifest = readManifest();
    expect(checkManifestCoverage(manifest)).toEqual([]);
  });

  it("checkManifestCoverage flags a fixture that is missing from the manifest", () => {
    // Simulate the bug the reviewer described: a fixture JSON lands in the
    // tree but its manifest entry is forgotten, so the admin endpoint could
    // register it via `{ kind: "fixture", fixture: "..." }` without a
    // pre-test schema check. The coverage helper must fail fast with an
    // entry that calls out the exact un-declared path.
    const failures = checkManifestCoverage([]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => /eventList\.empty\.json/.test(f))).toBe(true);
    // The deliberate malformed fixture uses the .malformed.json suffix and
    // should be silently skipped by the coverage check.
    expect(failures.every((f) => !/eventList\.malformed\.json/.test(f))).toBe(
      true,
    );
  });

  it("runFixturePreflight composes schema validation with coverage", () => {
    const failures = runFixturePreflight([]);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((f) => /is not declared in manifest\.json/.test(f)),
    ).toBe(true);
  });

  it("checkManifestConsistency passes for the shipped manifest", () => {
    const manifest = readManifest();
    expect(checkManifestConsistency(manifest)).toEqual([]);
  });

  it("checkManifestConsistency flags an operation that does not match the query root", () => {
    // The live registry is keyed off `entry.operation`, so a typo here
    // silently produces `mock-server: no stub registered` at request
    // time. Preflight must catch the metadata mismatch instead.
    const failures = checkManifestConsistency([
      {
        operation: "nonexistentField",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/eventList.empty.json",
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/does not match any root field/);
    expect(failures[0]).toMatch(/'eventList'/);
  });

  it("checkManifestConsistency flags a fixture missing the operation root key", async () => {
    // A fixture that omits the `entry.operation` root key would resolve
    // quietly to `null` on nullable roots under `graphql.execute()`, so
    // schema validation alone cannot catch this. Simulate by writing a
    // temporary manifest entry whose fixture is valid JSON but does
    // not own the expected top-level key.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, relative } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fixture-key-test-"));
    try {
      const absFixture = join(dir, "miskeyed.json");
      writeFileSync(absFixture, JSON.stringify({ somethingElse: null }));
      const fixtureRel = relative(
        resolve(__dirname, "../../fixtures"),
        absFixture,
      );
      const failures = checkManifestConsistency([
        {
          operation: "eventList",
          query: "detection/eventList.empty.graphql",
          fixture: fixtureRel,
        },
      ]);
      expect(failures.length).toBe(1);
      expect(failures[0]).toMatch(/missing the top-level 'eventList' key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkManifestConsistency accepts an explicit null for the operation root", async () => {
    // If the response is legitimately null (e.g. nullable root field),
    // the fixture must still *own* the key — explicit null passes, a
    // missing key does not.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, relative } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fixture-null-test-"));
    try {
      const absFixture = join(dir, "explicit-null.json");
      writeFileSync(absFixture, JSON.stringify({ eventList: null }));
      const fixtureRel = relative(
        resolve(__dirname, "../../fixtures"),
        absFixture,
      );
      const failures = checkManifestConsistency([
        {
          operation: "eventList",
          query: "detection/eventList.empty.graphql",
          fixture: fixtureRel,
        },
      ]);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkManifestCatchAllSafety passes for the shipped manifest", () => {
    const manifest = readManifest();
    expect(checkManifestCatchAllSafety(manifest)).toEqual([]);
  });

  it("checkManifestCatchAllSafety rejects a catch-all entry paired with a query that has required variables", () => {
    // `eventList.empty.graphql` declares `$filter: EventListFilterInput!`,
    // so a manifest entry with no `variables` cannot be validated by
    // `graphql.execute()`. The preflight must reject this pattern with a
    // clear error instead of letting it fail later with a cryptic
    // "missing required variable" message.
    const failures = checkManifestCatchAllSafety([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/eventList.empty.json",
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/required variable \$filter/);
    expect(failures[0]).toMatch(/\/__admin\/stubs/);
  });

  it("checkManifestCatchAllSafety treats variables: {} the same as omitted", () => {
    const failures = checkManifestCatchAllSafety([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/eventList.empty.json",
        variables: {},
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/required variable \$filter/);
  });

  it("checkManifestCatchAllSafety accepts a catch-all entry when the query has no required variables", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, relative } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fixture-catchall-test-"));
    try {
      const absQuery = join(dir, "no-required-vars.graphql");
      const absFixture = join(dir, "no-required-vars.json");
      // The check is document-only — it parses the query and scans its
      // variable definitions. Use `__typename` to decouple the test from
      // concrete schema fields.
      writeFileSync(absQuery, "query NoVars { __typename }\n");
      writeFileSync(absFixture, JSON.stringify({ __typename: "Query" }));
      const fixturesRoot = resolve(__dirname, "../../fixtures");
      const queryRel = relative(fixturesRoot, absQuery);
      const fixtureRel = relative(fixturesRoot, absFixture);
      const failures = checkManifestCatchAllSafety([
        {
          operation: "__typename",
          query: queryRel,
          fixture: fixtureRel,
        },
      ]);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkManifestDuplicates passes for the shipped manifest", () => {
    const manifest = readManifest();
    expect(checkManifestDuplicates(manifest)).toEqual([]);
  });

  it("checkManifestDuplicates rejects two catch-all entries for the same operation", () => {
    // Two catch-all entries hit the same specificity tier in the live
    // registry (both have no `match` predicate). `StubRegistry.resolve()`
    // walks the catch-all tier last-registered-first, so manifest order
    // would silently decide which fixture answers matching requests.
    // Preflight must flag this instead of letting the author ship it.
    const failures = checkManifestDuplicates([
      {
        operation: "trafficFilterList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/first.json",
      },
      {
        operation: "trafficFilterList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/second.json",
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/catch-all/);
    expect(failures[0]).toMatch(/detection\/first\.json/);
    expect(failures[0]).toMatch(/detection\/second\.json/);
  });

  it("checkManifestDuplicates rejects two narrow entries with identical variables", () => {
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
        variables: { filter: {}, first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: { filter: {}, first: 10 },
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/variables shape/);
    expect(failures[0]).toMatch(/detection\/a\.json/);
    expect(failures[0]).toMatch(/detection\/b\.json/);
  });

  it("checkManifestDuplicates collapses `variables: {}` to the same tier as omitted", () => {
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: {},
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/catch-all/);
  });

  it("checkManifestDuplicates treats different `variables` shapes as distinct", () => {
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
        variables: { filter: {}, first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: { filter: {}, first: 50 },
      },
    ]);
    expect(failures).toEqual([]);
  });

  it("checkManifestDuplicates accepts one matcher being a strict superset of another", () => {
    // Strict subset overlap: `{ first: 10 }` matches any request that
    // `{ filter: {}, first: 10 }` matches, plus more. The specificity-first
    // resolver picks the 2-key matcher deterministically, so this pair is
    // safe by construction and preflight must allow it.
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/broader.json",
        variables: { first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/narrower.json",
        variables: { filter: {}, first: 10 },
      },
    ]);
    expect(failures).toEqual([]);
  });

  it("checkManifestDuplicates rejects overlapping matchers where neither is a strict superset", () => {
    // `{ filter: {}, first: 10 }` and `{ first: 10, after: "x" }` agree on
    // their only shared key (`first: 10`), so a request carrying
    // `{ filter: {}, first: 10, after: "x" }` satisfies both at the same
    // 2-key specificity. Specificity-first has no winner there and falls
    // through to registration order — so preflight has to reject the pair
    // instead of letting manifest order silently decide the outcome.
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
        variables: { filter: {}, first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: { first: 10, after: "x" },
      },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/overlapping specific matchers/);
    expect(failures[0]).toMatch(/detection\/a\.json/);
    expect(failures[0]).toMatch(/detection\/b\.json/);
  });

  it("checkManifestDuplicates accepts overlapping matchers that contradict on a shared key", () => {
    // `{ first: 10 }` and `{ first: 50 }` agree on zero requests — they
    // disagree on their only shared key. No ambiguity, no preflight error.
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
        variables: { first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: { first: 50 },
      },
    ]);
    expect(failures).toEqual([]);
  });

  it("checkManifestDuplicates treats different key orderings as identical", () => {
    // Two entries that serialize to the same JSON after key-sorting are
    // the same matcher at runtime: `shallowEqualsSubset` compares each
    // key's JSON.stringify individually, so `{ a: 1, b: 2 }` and
    // `{ b: 2, a: 1 }` accept the same request variables. Preflight
    // has to canonicalize on sorted keys, otherwise a duplicate written
    // in the opposite order would slip through the check.
    const failures = checkManifestDuplicates([
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/a.json",
        variables: { filter: {}, first: 10 },
      },
      {
        operation: "eventList",
        query: "detection/eventList.empty.graphql",
        fixture: "detection/b.json",
        variables: { first: 10, filter: {} },
      },
    ]);
    expect(failures.length).toBe(1);
  });

  it("extractRootFieldNames follows fragment spreads on the operation root", () => {
    // A schema-valid document where the root selection is a fragment
    // spread must still expose its fields for both preflight consistency
    // and the mock-server router — otherwise the reviewer's flagged
    // pattern (`query Q { ...RootFields }`) routes to `Q` and produces a
    // `no stub registered` error, or fails preflight for having "no
    // top-level field selections".
    const doc = parse(`
      query Q { ...RootFields }
      fragment RootFields on Query { eventList { totalCount } }
    `);
    expect(extractRootFieldNames(doc)).toEqual(["eventList"]);
  });

  it("extractRootFieldNames flattens inline fragments and nested spreads", () => {
    const doc = parse(`
      query Q {
        ... on Query { indicatorList { name } }
        ...Outer
      }
      fragment Outer on Query { ...Inner }
      fragment Inner on Query { eventList { totalCount } }
    `);
    expect(extractRootFieldNames(doc).sort()).toEqual([
      "eventList",
      "indicatorList",
    ]);
  });

  it("checkManifestConsistency accepts a query whose root is a fragment spread", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, relative } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fixture-fragment-test-"));
    try {
      const absQuery = join(dir, "eventList.fragment.graphql");
      writeFileSync(
        absQuery,
        `query Q($filter: EventListFilterInput!, $first: Int) { ...RootFields }
         fragment RootFields on Query {
           eventList(filter: $filter, first: $first) { totalCount }
         }\n`,
      );
      const fixturesRootDir = resolve(__dirname, "../../fixtures");
      const queryRel = relative(fixturesRootDir, absQuery);
      const failures = checkManifestConsistency([
        {
          operation: "eventList",
          query: queryRel,
          fixture: "detection/eventList.empty.json",
          variables: { filter: {}, first: 10 },
        },
      ]);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a null value for a nullable top-level field", () => {
    // Regression guard: the previous validator flagged every top-level
    // null as a failure, which produced false positives for schema fields
    // that are legitimately nullable (e.g. `trafficFilterList: [TrafficFilter!]`
    // — the list itself is nullable). Schema execution should be the sole
    // arbiter of nullability.
    const document = parse(`{ trafficFilterList(agents: []) { agent } }`);
    const result = executeFixture(document, { trafficFilterList: null }, {});
    const failure = describeFailure("nullable-toplevel-fixture", result);
    expect(failure).toBeNull();
  });
});
