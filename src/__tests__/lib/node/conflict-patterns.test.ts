import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractUpstreamGraphQLMessage,
  mapConflictError,
  mapConflictMessage,
  NodeAgentNotFoundError,
  type NodeConflictError,
  NodeCustomerScopeError,
  NodeHostnameUniqueError,
  NodeNameUniqueError,
  NodeStaleConflictError,
  patternMatchers,
  serviceKindFromAgentNotFound,
} from "@/lib/node/conflict-patterns";

const FIXTURE_DIR = path.join(
  process.cwd(),
  "src",
  "__tests__",
  "lib",
  "node",
  "fixtures",
  "conflict-messages",
);

interface FixtureCase {
  name: string;
  expected: new (...args: never[]) => NodeConflictError;
  field: NodeConflictError["field"];
}

const FIXTURE_CASES: readonly FixtureCase[] = [
  {
    name: "node-name-unique.txt",
    expected: NodeNameUniqueError,
    field: "name",
  },
  {
    name: "node-hostname-unique.txt",
    expected: NodeHostnameUniqueError,
    field: "hostname",
  },
  {
    name: "node-customer-not-found.txt",
    expected: NodeCustomerScopeError,
    field: "customerId",
  },
  {
    name: "node-customer-no-access.txt",
    expected: NodeCustomerScopeError,
    field: "customerId",
  },
  {
    name: "stale-conflict.txt",
    expected: NodeStaleConflictError,
    field: null,
  },
  {
    name: "agent-not-found.txt",
    expected: NodeAgentNotFoundError,
    field: "service",
  },
];

function readFixturePayload(name: string): string {
  const raw = readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  // Strip the leading `# ...` header comments and any trailing newline so
  // the test feeds the matcher exactly the message string the upstream
  // would emit.
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

describe("conflict-patterns fixtures", () => {
  it("the fixture directory exists and contains every documented capture", () => {
    const entries = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".txt"));
    expect(entries.sort()).toEqual(
      [
        "agent-not-found.txt",
        "node-customer-no-access.txt",
        "node-customer-not-found.txt",
        "node-hostname-unique.txt",
        "node-name-unique.txt",
        "stale-conflict.txt",
      ].sort(),
    );
  });

  for (const fixture of FIXTURE_CASES) {
    it(`maps ${fixture.name} to the documented typed error`, () => {
      const message = readFixturePayload(fixture.name);
      const mapped = mapConflictMessage(message);
      expect(mapped).not.toBeNull();
      expect(mapped).toBeInstanceOf(fixture.expected);
      expect(mapped?.field).toBe(fixture.field);
      expect(mapped?.message).toBe(message);
    });
  }

  it("each fixture matches exactly one documented pattern (raw regex hit count)", () => {
    // Round 6 reviewer's guard: `mapConflictMessage` stops at the first
    // matching regex, so an "exactly one match" assertion built on it
    // would still pass when two patterns both match (as long as the
    // earlier one builds the expected typed error). Count raw regex hits
    // across the documented pattern table directly so a future regex
    // tweak that broadens one pattern can't silently overlap another
    // fixture's category.
    const matchers = patternMatchers();
    for (const fixture of FIXTURE_CASES) {
      const message = readFixturePayload(fixture.name);
      const hits = matchers.filter((p) => p.test(message)).length;
      expect(
        hits,
        `${fixture.name} should match exactly one pattern, got ${hits}`,
      ).toBe(1);
      // Also assert the typed-error mapping still routes correctly,
      // since exclusivity alone doesn't pin the destination class.
      const mapped = mapConflictMessage(message);
      expect(mapped).toBeInstanceOf(fixture.expected);
    }
  });

  it("returns null for unrecognised messages", () => {
    expect(mapConflictMessage("internal server error")).toBeNull();
    expect(mapConflictMessage("")).toBeNull();
    expect(mapConflictMessage(undefined)).toBeNull();
  });
});

describe("mapConflictError", () => {
  it("matches against an Error instance's message", () => {
    const err = new Error("the node's name already exists");
    expect(mapConflictError(err)).toBeInstanceOf(NodeNameUniqueError);
  });

  it("matches against graphql-request response.errors[].message", () => {
    const err = {
      message: "wrapper text",
      response: {
        errors: [{ message: "hostname host-1 already in use" }],
      },
    };
    expect(mapConflictError(err)).toBeInstanceOf(NodeHostnameUniqueError);
  });

  it("returns null when nothing matches", () => {
    expect(mapConflictError(new Error("boom"))).toBeNull();
    expect(mapConflictError(null)).toBeNull();
    expect(mapConflictError({})).toBeNull();
  });
});

describe("serviceKindFromAgentNotFound", () => {
  // The BFF uses this to surface the affected accordion section for an
  // `agent <key> not found` upstream conflict — without it the dialog
  // would have to fall back to a footer banner that names no service.
  it("maps each known agent serviceKey to its registry kind", () => {
    expect(
      serviceKindFromAgentNotFound("agent piglet not found on node 42"),
    ).toBe("sensor");
    expect(serviceKindFromAgentNotFound("agent hog not found")).toBe(
      "semi-supervised",
    );
    expect(serviceKindFromAgentNotFound("agent crusher not found")).toBe(
      "time-series",
    );
    expect(serviceKindFromAgentNotFound("agent reconverge not found")).toBe(
      "unsupervised",
    );
    expect(serviceKindFromAgentNotFound("agent giganto not found")).toBe(
      "data-store",
    );
    expect(serviceKindFromAgentNotFound("agent tivan not found")).toBe(
      "ti-container",
    );
  });

  it("returns null for unknown agent identifiers", () => {
    expect(
      serviceKindFromAgentNotFound("agent unknown-thing not found"),
    ).toBeNull();
  });

  it("returns null for messages that are not agent-not-found shaped", () => {
    expect(
      serviceKindFromAgentNotFound("the node's name already exists"),
    ).toBeNull();
    expect(serviceKindFromAgentNotFound(undefined)).toBeNull();
    expect(serviceKindFromAgentNotFound(null)).toBeNull();
  });
});

describe("extractUpstreamGraphQLMessage", () => {
  // The BFF needs to distinguish a GraphQL upstream error (rich
  // `response.errors[]`, suitable for the dialog footer banner) from
  // a generic programming bug (which should bubble as 500 so it is
  // visible in logs and not papered over by a fake conflict shape).
  it("returns the first non-empty message on a graphql-request shape", () => {
    const err = Object.assign(new Error("aggregate"), {
      response: {
        errors: [
          { message: "" },
          { message: "review-web rejected the mutation: novel case" },
        ],
      },
    });
    expect(extractUpstreamGraphQLMessage(err)).toBe(
      "review-web rejected the mutation: novel case",
    );
  });

  it("returns null when there is no response.errors array", () => {
    expect(extractUpstreamGraphQLMessage(new Error("boom"))).toBeNull();
    expect(extractUpstreamGraphQLMessage(null)).toBeNull();
    expect(extractUpstreamGraphQLMessage({})).toBeNull();
    expect(
      extractUpstreamGraphQLMessage({ response: { errors: [] } }),
    ).toBeNull();
  });

  it("returns null when every entry has an empty message", () => {
    expect(
      extractUpstreamGraphQLMessage({
        response: { errors: [{ message: "" }, {}] },
      }),
    ).toBeNull();
  });
});
