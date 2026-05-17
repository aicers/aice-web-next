import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeFakePool() {
  const calls: FakeQueryCall[] = [];
  let response: (sql: string) => { rows: unknown[]; rowCount: number } =
    () => ({
      rows: [],
      rowCount: 0,
    });

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    connect: vi.fn(async () => client),
  };

  return {
    pool,
    client,
    calls,
    setResponse: (
      fn: (sql: string) => { rows: unknown[]; rowCount: number },
    ) => {
      response = fn;
    },
  };
}

const fake = makeFakePool();
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: vi.fn(async () => fake.pool),
}));

describe("loadStoryStreamingSlice cursor SQL", () => {
  let storyPush: typeof import("@/lib/aimer/phase2/story-push");

  beforeEach(async () => {
    storyPush = await import("@/lib/aimer/phase2/story-push");
    fake.calls.length = 0;
    fake.client.query.mockClear();
    fake.pool.query.mockClear();
    fake.pool.connect.mockClear();
    fake.client.release.mockClear();
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("orders + cursor-compares by (created_at, id), not (time_window_end, id)", async () => {
    // Round-4 regression: the streaming cursor key for the `story`
    // kind MUST be `(created_at, id)` so a Story inserted between
    // mint and ack cannot end up permanently behind the advanced
    // cursor. Cursoring on `(time_window_end, id)` would let a late
    // insert with an in-range `time_window_end` slip past the
    // cursor and never be delivered by a subsequent drain. See the
    // module comment on src/lib/aimer/phase2/story-push.ts.
    await storyPush.loadStoryStreamingSlice({
      customerId: 42,
      cursorEventTime: new Date("2026-01-01T00:00:00Z"),
      cursorEventKey: "100",
    });
    const sliceCall = fake.calls.find((c) =>
      c.sql.includes("FROM event_group"),
    );
    expect(sliceCall).toBeDefined();
    const sql = sliceCall?.sql ?? "";
    expect(sql).toContain("(created_at, id::numeric) > ");
    expect(sql).not.toContain("(time_window_end, id::numeric) > ");
    expect(sql).toContain("ORDER BY created_at, id");
    expect(sql).not.toMatch(/ORDER BY\s+time_window_end\b/);
  });

  it("returns the last delivered Story's created_at as the cursor advance target", async () => {
    // The cursor target on ack is `(created_at, id)` of the last
    // delivered row, not `(time_window_end, id)`. Returning
    // `time_window_end` here would re-introduce the late-insert
    // race the cursor key change closes.
    const createdAt = new Date("2026-02-15T10:00:00Z");
    const timeWindowEnd = new Date("2026-01-05T00:00:00Z");
    fake.setResponse((sql) => {
      if (sql.includes("FROM event_group_member")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM event_group")) {
        return {
          rows: [
            {
              story_id: "999",
              story_version: "v1",
              kind: "auto_correlated",
              correlation_rule_id: null,
              primary_asset: null,
              time_window_start: "2026-01-01T00:00:00.000Z",
              time_window_end: "2026-01-05T00:00:00.000Z",
              time_window_end_date: timeWindowEnd,
              score: null,
              summary_payload: {},
              created_at: "2026-02-15T10:00:00.000Z",
              created_at_date: createdAt,
              last_sent_at: null,
              last_sent_by: null,
              send_count: 0,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const slice = await storyPush.loadStoryStreamingSlice({
      customerId: 42,
      cursorEventTime: null,
      cursorEventKey: null,
    });
    expect(slice.stories).toHaveLength(1);
    expect(slice.lastEventKey).toBe("999");
    expect(slice.lastEventTime).toEqual(createdAt);
    expect(slice.lastEventTime).not.toEqual(timeWindowEnd);
  });
});
