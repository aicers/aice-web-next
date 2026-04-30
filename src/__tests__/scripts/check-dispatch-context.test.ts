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
