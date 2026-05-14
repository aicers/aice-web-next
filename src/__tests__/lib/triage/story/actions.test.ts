import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { SaveCuratedStoryInput } from "@/lib/triage/story/types";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockCentralQuery = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
  CustomerNotFoundError: class CustomerNotFoundError extends Error {},
}));

vi.mock("@/lib/db/client", () => ({
  query: mockCentralQuery,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

import { saveAnalystCuratedStory } from "@/lib/triage/story/actions";
import { STORY_MEMBER_CAP } from "@/lib/triage/story/rules";

function makeSession(): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 1,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: 0,
    exp: 0,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "test",
    sessionBrowserFingerprint: "test",
    needsReauth: false,
    sessionCreatedAt: new Date(0),
    sessionLastActiveAt: new Date(0),
  } as AuthSession;
}

const PERIOD = {
  startIso: "2026-05-08T00:00:00.000Z",
  endIso: "2026-05-09T00:00:00.000Z",
};

/**
 * Mock tenant pool: returns the given members on a
 * SELECT_BASELINE_EVENTS_BY_KEY_SQL probe, otherwise returns the new
 * group id on INSERT INTO event_group.
 */
function makeTenantPool(opts: {
  resolved?: Array<{
    event_key: string;
    event_time: Date;
    kind: string;
    orig_addr: string | null;
    category: string | null;
    selector_tags: string[] | null;
    raw_score: number;
  }>;
  newGroupId?: string;
}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO event_group ")) {
        return { rows: [{ id: opts.newGroupId ?? "1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO event_group_member")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM baseline_triaged_event")) {
        return {
          rows: opts.resolved ?? [],
          rowCount: (opts.resolved ?? []).length,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => client),
  };
  return { pool, client };
}

describe("saveAnalystCuratedStory — six error paths from #490 acceptance", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGetCustomerPool.mockReset();
    mockCentralQuery.mockReset();
    mockAuditRecord.mockReset();
    // Default: caller is in scope of customer 42 only.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
  });

  it("CUSTOMER_OUT_OF_SCOPE — customerId not in caller's effective scope", async () => {
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 999, // not in scope
        memberEventKeys: ["1"],
        memberCustomerIds: [999],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "CUSTOMER_OUT_OF_SCOPE", customerId: 999 },
    });
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("EMPTY — memberEventKeys array is empty", async () => {
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: [],
        memberCustomerIds: [],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EMPTY");
  });

  it("OVER_CAP — memberEventKeys exceeds STORY_MEMBER_CAP", async () => {
    const keys = Array.from({ length: STORY_MEMBER_CAP + 1 }, (_, i) =>
      String(i + 1),
    );
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: keys,
        memberCustomerIds: keys.map(() => 42),
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OVER_CAP");
      if (result.error.code === "OVER_CAP") {
        expect(result.error.cap).toBe(STORY_MEMBER_CAP);
        expect(result.error.received).toBe(STORY_MEMBER_CAP + 1);
      }
    }
    // Cap check is short-circuit before any DB work.
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
  });

  it("MEMBER_NOT_FOUND — an event_key is missing in the resolved tenant DB (cross-tenant case)", async () => {
    // Resolved tenant has "1" but not "2".
    const { pool } = makeTenantPool({
      resolved: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T12:00:00Z"),
          kind: "HttpThreat",
          orig_addr: "10.0.0.5",
          category: "IMPACT",
          selector_tags: [],
          raw_score: 1,
        },
      ],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1", "2"],
        memberCustomerIds: [42, 42],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "MEMBER_NOT_FOUND") {
      expect(result.error.missingEventKeys).toEqual(["2"]);
    } else {
      throw new Error(
        `expected MEMBER_NOT_FOUND, got ${JSON.stringify(result)}`,
      );
    }
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("ASSET_MISMATCH — primaryAsset matches no resolved member's orig_addr", async () => {
    const { pool } = makeTenantPool({
      resolved: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T12:00:00Z"),
          kind: "HttpThreat",
          orig_addr: "10.0.0.5",
          category: "IMPACT",
          selector_tags: [],
          raw_score: 1,
        },
      ],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1"],
        memberCustomerIds: [42],
        primaryAsset: "10.99.99.99", // no member has this orig_addr
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "ASSET_MISMATCH") {
      expect(result.error.primaryAsset).toBe("10.99.99.99");
    } else {
      throw new Error(`expected ASSET_MISMATCH, got ${JSON.stringify(result)}`);
    }
  });

  it("happy path — inserts curated row, persists manualTitle, emits audit with composite key fields", async () => {
    const { pool, client } = makeTenantPool({
      resolved: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T12:00:00Z"),
          kind: "HttpThreat",
          orig_addr: "10.0.0.5",
          category: "IMPACT",
          selector_tags: [],
          raw_score: 1,
        },
        {
          event_key: "2",
          event_time: new Date("2026-05-09T12:30:00Z"),
          kind: "DnsCovertChannel",
          orig_addr: "10.0.0.5",
          category: "EXFILTRATION",
          selector_tags: [],
          raw_score: 2,
        },
      ],
      newGroupId: "777",
    });
    mockGetCustomerPool.mockResolvedValue(pool);

    const input: SaveCuratedStoryInput = {
      customerId: 42,
      memberEventKeys: ["1", "2"],
      memberCustomerIds: [42, 42],
      primaryAsset: "10.0.0.5",
      title: "Lateral movement on 10.0.0.5",
    };
    const result = await saveAnalystCuratedStory(makeSession(), input, {
      period: PERIOD,
    });

    expect(result).toEqual({ ok: true, customerId: 42, storyId: "777" });

    // manualTitle persisted under summary_payload.manualTitle.
    const insertCall = client.query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO event_group"),
    );
    expect(insertCall).toBeDefined();
    const summaryParam = JSON.parse(
      String((insertCall as unknown as [string, unknown[]])[1][5]),
    );
    expect(summaryParam.manualTitle).toBe("Lateral movement on 10.0.0.5");
    expect(summaryParam.memberCount).toBe(2);

    // Audit emits customerId + storyId + memberCount + manualTitle.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const auditCall = mockAuditRecord.mock.calls[0][0];
    expect(auditCall.action).toBe("triage.story.create");
    expect(auditCall.target).toBe("triage_story");
    expect(auditCall.targetId).toBe("777");
    expect(auditCall.customerId).toBe(42);
    expect(auditCall.details).toEqual({
      customerId: 42,
      storyId: "777",
      memberCount: 2,
      manualTitle: "Lateral movement on 10.0.0.5",
    });
  });

  it("happy path without title — manualTitle absent from summary_payload (not empty string), audit records null", async () => {
    const { pool, client } = makeTenantPool({
      resolved: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T12:00:00Z"),
          kind: "HttpThreat",
          orig_addr: "10.0.0.5",
          category: "IMPACT",
          selector_tags: [],
          raw_score: 1,
        },
      ],
      newGroupId: "778",
    });
    mockGetCustomerPool.mockResolvedValue(pool);

    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1"],
        memberCustomerIds: [42],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(true);

    const insertCall = client.query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO event_group"),
    );
    const summaryParam = JSON.parse(
      String((insertCall as unknown as [string, unknown[]])[1][5]),
    );
    // The key should be absent rather than present-with-empty-value.
    expect("manualTitle" in summaryParam).toBe(false);

    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord.mock.calls[0][0].details.manualTitle).toBeNull();
  });

  it("dedupes duplicate event keys before applying the cap and DB lookup", async () => {
    const { pool } = makeTenantPool({
      resolved: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T12:00:00Z"),
          kind: "HttpThreat",
          orig_addr: "10.0.0.5",
          category: "IMPACT",
          selector_tags: [],
          raw_score: 1,
        },
      ],
      newGroupId: "780",
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1", "1", "1"], // duplicated
        memberCustomerIds: [42, 42, 42],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result.ok).toBe(true);
  });

  it("MULTI_CUSTOMER_NOT_ALLOWED — at least one memberCustomerIds entry mismatches customerId", async () => {
    // Caller is in scope of customers 42 AND 99; the analyst's pivot
    // focus straddled both, and the modal — for whatever reason —
    // sent the parallel array un-sanitized. The server is the
    // authoritative gate and rejects the input before any DB work.
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1", "2"],
        memberCustomerIds: [42, 99],
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "MULTI_CUSTOMER_NOT_ALLOWED" },
    });
    // Mixed-tenant input must short-circuit before any DB work.
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects an over-length title server-side rather than silently truncating", async () => {
    // The schema bounds `title` at 200 trimmed chars; a 201-char input
    // is rejected at parse time and never reaches the DB or audit
    // sinks. This prevents a direct action caller (curl, test, etc.)
    // from storing a manualTitle that disagrees with the
    // analyst-submitted intent. The current error-code set has no
    // dedicated "TITLE_TOO_LONG"; we route the parse failure through
    // the shape-error → EMPTY fallback so the action remains a
    // reject without expanding the documented error contract.
    const oversize = "x".repeat(201);
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1"],
        memberCustomerIds: [42],
        primaryAsset: "10.0.0.5",
        title: oversize,
      },
      { period: PERIOD },
    );
    expect(result).toEqual({ ok: false, error: { code: "EMPTY" } });
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("MULTI_CUSTOMER_NOT_ALLOWED — memberCustomerIds length mismatches memberEventKeys", async () => {
    // A length mismatch is a contract violation: there is no single
    // tenant we can pin every key to. The server treats it as the
    // multi-customer error rather than silently truncating to one.
    const result = await saveAnalystCuratedStory(
      makeSession(),
      {
        customerId: 42,
        memberEventKeys: ["1", "2"],
        memberCustomerIds: [42], // length mismatch
        primaryAsset: "10.0.0.5",
      },
      { period: PERIOD },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "MULTI_CUSTOMER_NOT_ALLOWED" },
    });
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
  });
});
