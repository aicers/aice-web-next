import { describe, expect, it } from "vitest";

import { checkFiles } from "../../../scripts/check-dispatch-context.mjs";

interface FixtureFile {
  relPath: string;
  source: string;
}

interface Violation {
  relPath: string;
  lineNumber: number;
  message: string;
}

function run(files: FixtureFile[]): Violation[] {
  return checkFiles(files) as Violation[];
}

describe("check-dispatch-context guard", () => {
  it("flags a graphqlRequest call site outside the allowlist", () => {
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].relPath).toBe("src/app/api/feature/route.ts");
    expect(violations[0].message).toMatch(/outside the dispatch-context/);
  });

  it("accepts an out-of-allowlist call site with a non-empty override", () => {
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequest(QUERY, undefined, { role: "admin" }); // scope-allowlist: introspection-only health probe
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("rejects an empty override reason", () => {
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequest(QUERY, undefined, { role: "admin" }); // scope-allowlist:
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
  });

  it("accepts an allowlisted file that imports buildDispatchContext", () => {
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";
import { buildDispatchContext } from "./dispatch-context";

export async function listNodes(session) {
  const ctx = await buildDispatchContext(session);
  return graphqlRequest(NODE_LIST_QUERY, undefined, ctx);
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("accepts an allowlisted file that locally declares buildDispatchContext", () => {
    const violations = run([
      {
        relPath: "src/lib/detection/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

async function buildDispatchContext(session, filter) {
  return { role: session.roles[0], customerIds: [], filter };
}

export async function listEvents(session, filter) {
  const ctx = await buildDispatchContext(session, filter);
  return graphqlRequest(EVENT_LIST_QUERY, undefined, ctx);
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("flags an allowlisted file that has neither import nor local declaration", () => {
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("ignores files that do not call the helpers", () => {
    const violations = run([
      {
        relPath: "src/components/whatever.tsx",
        source: `export function Whatever() {
  return null;
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("matches both graphqlRequest and graphqlRequestTo", () => {
    const violations = run([
      {
        relPath: "src/app/api/other/route.ts",
        source: `import { graphqlRequestTo } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequestTo(URL, QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].lineNumber).toBe(4);
  });

  it("flags an out-of-allowlist call site that is split across lines", () => {
    // Regression test for the round-2 review: the previous
    // line-by-line scanner missed `graphqlRequest\n  (...)` because
    // the helper name and the `(` were not on the same line. The
    // whole-source scan should still find the call.
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequest
    (QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].relPath).toBe("src/app/api/feature/route.ts");
    expect(violations[0].message).toMatch(/outside the dispatch-context/);
  });

  it("accepts a split-line override comment on any line of the call expression", () => {
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

export async function GET() {
  return graphqlRequest
    (QUERY, undefined, { role: "admin" }); // scope-allowlist: introspection-only health probe
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does NOT count a commented-out import of buildDispatchContext as in-scope", () => {
    // Regression test for the round-2 review: the previous presence
    // check ran the import regex against raw source, so a
    // `// import { buildDispatchContext } ...` line satisfied it even
    // though the symbol is not actually in scope.
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";
// import { buildDispatchContext } from "./dispatch-context";

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("does NOT count a block-commented import as in-scope", () => {
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";
/*
import { buildDispatchContext } from "./dispatch-context";
*/

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("does NOT count a commented-out call site as a call", () => {
    // A commented-out invocation in an allowlisted file shouldn't
    // trigger the presence check (and likewise shouldn't cause a
    // violation when the file is OUT of the allowlist).
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `// const x = graphqlRequest(QUERY, undefined, ctx);

export function GET() {
  return new Response("ok");
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does NOT count an `import { buildDispatchContext } ...` substring inside a string literal as in-scope", () => {
    // Regression test for the round-3 review: the previous stripper
    // preserved string contents, so a fixture-style string literal
    // that happened to contain the import substring satisfied the
    // presence check. Stripping string contents fixes this.
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

const fixture = "import { buildDispatchContext } from './dispatch-context';";

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("does NOT report a `graphqlRequest(...)` substring inside a string literal as a call site", () => {
    // Regression test for the round-3 review: the previous stripper
    // preserved string contents, so a string literal in a non-
    // allowlisted file that contained `graphqlRequest(QUERY)` was
    // reported as an out-of-allowlist call. Stripping string
    // contents avoids the false positive.
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `const fixture = "graphqlRequest(QUERY)";

export function GET() {
  return new Response(fixture);
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does NOT report a `graphqlRequest(...)` substring inside a template literal as a call site", () => {
    const violations = run([
      {
        relPath: "src/app/api/feature/route.ts",
        source: `const fixture = \`example: graphqlRequest(QUERY)\`;

export function GET() {
  return new Response(fixture);
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does NOT count `import type { buildDispatchContext } ...` as in-scope", () => {
    // Regression test for the round-4 review: type-only imports are
    // erased by the TS compiler so the symbol is not actually in
    // runtime scope. The previous regex accepted them.
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";
import type { buildDispatchContext } from "./dispatch-context";

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("does NOT count `import { type buildDispatchContext } ...` as in-scope", () => {
    // Per-specifier `type` modifier — also erased at runtime, so the
    // symbol is not in scope for the call site to use.
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";
import { type buildDispatchContext } from "./dispatch-context";

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("does NOT count a nested `function buildDispatchContext` as in-scope", () => {
    // Regression test for the round-4 review: a nested declaration
    // inside another function does not bring the symbol into file
    // scope, so it must NOT satisfy the presence check. The previous
    // regex permitted leading whitespace and matched indented
    // declarations.
    const violations = run([
      {
        relPath: "src/lib/node/server-actions.ts",
        source: `import { graphqlRequest } from "@/lib/graphql/client";

function wrapper() {
  async function buildDispatchContext() {
    return { role: "admin", customerIds: [] };
  }
  return buildDispatchContext;
}

export async function listNodes() {
  return graphqlRequest(QUERY, undefined, { role: "admin" });
}
`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(
      /neither imports nor locally declares/,
    );
  });

  it("treats the GraphQL client modules as pass-through (no buildDispatchContext required)", () => {
    const violations = run([
      {
        relPath: "src/lib/graphql/external-client.ts",
        source: `import { graphqlRequestTo } from "./client";

export async function gigantoClient(document, variables, context) {
  return graphqlRequestTo(URL, document, variables, context);
}
`,
      },
    ]);

    expect(violations).toEqual([]);
  });
});
