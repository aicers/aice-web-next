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

  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
  };

  return {
    pool,
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

describe("policy-run-send helpers", () => {
  let mod: typeof import("@/lib/aimer/phase2/policy-run-send");

  beforeEach(async () => {
    mod = await import("@/lib/aimer/phase2/policy-run-send");
    fake.calls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("pruneExpiredPolicyRunSendInflight", () => {
    it("deletes inflight rows at the send_action_id level, not per row", async () => {
      // The prune must not delete a long-running multi-batch Send's
      // oldest row while leaving its newer rows behind — that would
      // leave a partial inflight set that finalize could mistake for
      // a complete chain via set-equality on what *was* minted.
      fake.setResponse(() => ({ rows: [], rowCount: 4 }));
      const deleted = await mod.pruneExpiredPolicyRunSendInflight(1);

      expect(deleted).toBe(4);
      const call = fake.calls[0];
      expect(call.sql).toContain("DELETE FROM aimer_policy_run_send_inflight");
      // The outer DELETE keys on send_action_id, not on minted_at, so
      // every row of any stalled Send is removed in one statement.
      expect(call.sql).toMatch(/WHERE\s+send_action_id\s+IN\s*\(/);
      // The inner SELECT scopes the stalled set by minted_at vs TTL.
      expect(call.sql).toMatch(
        /SELECT\s+send_action_id\s+FROM\s+aimer_policy_run_send_inflight/,
      );
      expect(call.sql).toContain("minted_at < NOW() - make_interval");
      expect(call.params).toEqual([mod.POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS]);
    });

    it("does not filter the outer DELETE by minted_at directly (partial-prune regression guard)", async () => {
      // Guards against a regression where the prune again deletes
      // individual rows past TTL, which would leave mixed old/new
      // rows for the same send_action_id behind.
      fake.setResponse(() => ({ rows: [], rowCount: 0 }));
      await mod.pruneExpiredPolicyRunSendInflight(1);
      const sql = fake.calls[0].sql;
      // The TTL predicate must appear exactly once — inside the
      // subquery that picks stalled send_action_ids — never directly
      // on the outer DELETE.
      const ttlMatches = sql.match(/minted_at\s*<\s*NOW\(\)/g) ?? [];
      expect(ttlMatches.length).toBe(1);
    });

    it("exports POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS = 600", () => {
      expect(mod.POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS).toBe(600);
    });
  });
});
