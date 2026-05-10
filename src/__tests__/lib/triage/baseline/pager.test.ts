import { describe, expect, it, vi } from "vitest";
import {
  CADENCE_PAGE_SIZE,
  type CadencePagerOptions,
  createCadencePager,
  cursorToEventKey,
} from "@/lib/triage/baseline/pager";
import {
  EMPTY_EXCLUSIONS_FINGERPRINT,
  type ExclusionRule,
} from "@/lib/triage/exclusion";

interface FakeClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  query: ReturnType<typeof vi.fn>;
}

function makeClient(): FakeClient {
  const client: FakeClient = {
    queries: [],
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
  return client;
}

function eventKeyToCursor(value: bigint): string {
  // Big-endian 16-byte encoding; matches `cursorToEventKey`.
  const bytes = Buffer.alloc(16);
  let n = value;
  for (let i = 15; i >= 0; i -= 1) {
    bytes[i] = Number(n & BigInt(0xff));
    n = n >> BigInt(8);
  }
  return bytes.toString("base64");
}

describe("cursorToEventKey", () => {
  it("decodes a 16-byte big-endian base64 cursor to a NUMERIC string", () => {
    expect(cursorToEventKey(eventKeyToCursor(BigInt(1)))).toBe("1");
    expect(cursorToEventKey(eventKeyToCursor(BigInt(255)))).toBe("255");
    expect(
      cursorToEventKey(eventKeyToCursor(BigInt("123456789012345678901"))),
    ).toBe("123456789012345678901");
  });

  it("throws on a malformed cursor (length != 16 bytes)", () => {
    expect(() => cursorToEventKey("AAAA")).toThrow(/expected 16-byte/);
  });
});

describe("createCadencePager — full pipeline (a)–(e)", () => {
  it("normalizes, exclusions-filters, INSERTs into both corpus tables, and reports counts", async () => {
    const cursor1 = eventKeyToCursor(BigInt(1001));
    const cursor2 = eventKeyToCursor(BigInt(1002));
    const cursor3 = eventKeyToCursor(BigInt(1003));

    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor1,
          endCursor: cursor3,
        },
        edges: [
          {
            cursor: cursor1,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "COMMAND_AND_CONTROL",
              level: "MEDIUM",
              origAddr: "10.0.0.1",
              respAddr: "1.1.1.1",
              origPort: 50000,
              respPort: 443,
              host: "phish.example",
              uri: "/login",
              clusterId: "",
            },
          },
          {
            cursor: cursor2,
            // Whitelisted-only path (score 1.0).
            node: {
              __typename: "NetworkThreat",
              time: "2026-05-09T12:01:00.000Z",
              sensor: "sensor-a",
              category: "IMPACT",
              level: "MEDIUM",
              origAddr: "10.0.0.2",
              respAddr: "1.1.1.2",
              origPort: 51000,
              respPort: 443,
            },
          },
          {
            cursor: cursor3,
            // Score 0 — passes (b)/(c)/(d) but is dropped at (e).
            node: {
              __typename: "PortScan",
              time: "2026-05-09T12:02:00.000Z",
              sensor: "sensor-a",
              category: "RECONNAISSANCE",
              level: "LOW",
              origAddr: "10.0.0.3",
              respAddr: "1.1.1.3",
            },
          },
        ],
      },
    }));

    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result).toEqual({
      observedInserted: 3,
      baselineInserted: 2,
      endCursor: cursor3,
      hasNextPage: false,
    });

    // (d) one observed insert per surviving event.
    const observedInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO observed_event_meta"),
    );
    expect(observedInserts).toHaveLength(3);

    // (e) one baseline insert per baseline-passing event (HttpThreat
    // whitelisted+unlabeled = 1.5; NetworkThreat whitelisted = 1.0).
    const baselineInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(baselineInserts).toHaveLength(2);

    // Each baseline INSERT carries the empty-set exclusions_fp pre-#457.
    for (const insert of baselineInserts) {
      const params = insert.params ?? [];
      expect(params).toContain(EMPTY_EXCLUSIONS_FINGERPRINT);
    }

    // The first baseline insert (HttpThreat unlabeled-bonus) carries
    // the unlabeled-bonus selector tag.
    const httpThreatInsert = baselineInserts[0];
    const tags = (httpThreatInsert.params ?? []).find((p) =>
      Array.isArray(p),
    ) as string[] | undefined;
    expect(tags).toContain("phase1a-simple");
    expect(tags).toContain("unlabeled-bonus");

    // The second baseline insert (NetworkThreat whitelisted-only) does
    // NOT carry the unlabeled-bonus tag.
    const networkThreatInsert = baselineInserts[1];
    const networkTags = (networkThreatInsert.params ?? []).find((p) =>
      Array.isArray(p),
    ) as string[] | undefined;
    expect(networkTags).toEqual(["phase1a-simple"]);

    // fetchPage was called with the customer + null cursor on the
    // first page.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect((fetchPage.mock.calls[0] as unknown[])[0]).toMatchObject({
      filter: { customers: ["42"] },
      triage: null,
      first: CADENCE_PAGE_SIZE,
      after: null,
    });
  });

  it("drops events that match an active exclusion before INSERTing them anywhere", async () => {
    const cursor = eventKeyToCursor(BigInt(2001));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor,
          endCursor: cursor,
        },
        edges: [
          {
            cursor,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "COMMAND_AND_CONTROL",
              level: "MEDIUM",
              origAddr: "10.0.0.5",
              host: "ads.example.com",
              clusterId: "real-cluster",
            },
          },
        ],
      },
    }));

    const rule: ExclusionRule = { hostname: ["ads.example.com"] };
    const resolver = {
      async resolve() {
        return { rules: [rule] };
      },
    };
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      resolver,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );

    expect(result.observedInserted).toBe(0);
    expect(result.baselineInserted).toBe(0);
    // No INSERTs at all.
    expect(client.queries.some((q) => q.sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
  });

  it("threads the after cursor and reports hasNextPage from the resolver", async () => {
    const startCursor = eventKeyToCursor(BigInt(100));
    const endCursor = eventKeyToCursor(BigInt(101));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: true,
          hasNextPage: true,
          startCursor,
          endCursor,
        },
        edges: [],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      99,
      "previous-page-cursor",
    );

    expect(result.endCursor).toBe(endCursor);
    expect(result.hasNextPage).toBe(true);
    expect((fetchPage.mock.calls[0] as unknown[])[0]).toMatchObject({
      after: "previous-page-cursor",
    });
  });

  it("reports an empty page (no edges) without any INSERTs", async () => {
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result).toEqual({
      observedInserted: 0,
      baselineInserted: 0,
      endCursor: null,
      hasNextPage: false,
    });
    expect(client.queries.some((q) => q.sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
  });

  it("INSERTs into baseline_triaged_event for the unlabeled-only path (score 0.5)", async () => {
    const cursor = eventKeyToCursor(BigInt(3001));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor,
          endCursor: cursor,
        },
        edges: [
          {
            cursor,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "RECONNAISSANCE", // non-whitelisted
              level: "LOW",
              origAddr: "10.0.0.9",
              host: "novel.example",
              clusterId: "none",
            },
          },
        ],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result.baselineInserted).toBe(1);
    const baseInsert = client.queries.find((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(baseInsert).toBeDefined();
    // The score parameter (16th positional arg in our SQL) should be 0.5.
    expect(baseInsert?.params?.[15]).toBe(0.5);
  });
});
