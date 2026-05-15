import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { StoredExclusionSnapshotInput } from "@/lib/triage/exclusion/types";
import type { TriagePolicyRow } from "@/lib/triage/policy/types";
import {
  canonicalizeExclusionSnapshot,
  canonicalizePolicySnapshot,
  recordBaselineVersionSnapshot,
  recordExclusionSnapshot,
  recordPolicySnapshot,
} from "@/lib/triage/snapshot/writer";

interface FakeExecutor {
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
  query: ReturnType<typeof vi.fn>;
}

function makeExecutor(): FakeExecutor {
  const exec: FakeExecutor = {
    calls: [],
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      exec.calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
  return exec;
}

describe("canonicalizeExclusionSnapshot", () => {
  it("dedups (kind, value) pairs and preserves the first-seen scope label", () => {
    const rows: StoredExclusionSnapshotInput[] = [
      { scope: "global", kind: "hostname", value: "example.com" },
      // Same (kind, value) under customer scope is dropped — the global
      // observation wins because callers feed in deterministic order.
      { scope: "customer", kind: "hostname", value: "example.com" },
      { scope: "customer", kind: "ipAddress", value: "10.0.0.0/24" },
    ];
    // Sort order is lexicographic by (kind, value), so "hostname"
    // comes before "ipAddress". The dedup pass kept the first-seen
    // scope label for the hostname entry (global, not customer).
    expect(canonicalizeExclusionSnapshot(rows)).toEqual([
      {
        scope_first_observed: "global",
        kind: "hostname",
        value: "example.com",
      },
      {
        scope_first_observed: "customer",
        kind: "ipAddress",
        value: "10.0.0.0/24",
      },
    ]);
  });

  it("produces identical payloads for set-equal but reordered inputs", () => {
    const a: StoredExclusionSnapshotInput[] = [
      { scope: "global", kind: "hostname", value: "b.example" },
      { scope: "customer", kind: "uri", value: "/foo" },
      { scope: "global", kind: "hostname", value: "a.example" },
    ];
    const b: StoredExclusionSnapshotInput[] = [
      { scope: "global", kind: "hostname", value: "a.example" },
      { scope: "global", kind: "hostname", value: "b.example" },
      { scope: "customer", kind: "uri", value: "/foo" },
    ];
    expect(canonicalizeExclusionSnapshot(a)).toEqual(
      canonicalizeExclusionSnapshot(b),
    );
  });

  it("returns an empty array for the empty input", () => {
    expect(canonicalizeExclusionSnapshot([])).toEqual([]);
  });
});

describe("recordExclusionSnapshot", () => {
  it("INSERTs the canonical payload with ON CONFLICT DO NOTHING", async () => {
    const exec = makeExecutor();
    await recordExclusionSnapshot(exec as unknown as pg.Pool, "fp-abc", [
      { scope: "global", kind: "hostname", value: "x.example" },
    ]);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].sql).toContain("INSERT INTO exclusion_snapshot");
    expect(exec.calls[0].sql).toContain("ON CONFLICT (fingerprint) DO NOTHING");
    expect(exec.calls[0].params?.[0]).toBe("fp-abc");
    // Payload is canonicalized JSON before being shipped to JSONB.
    const payload = JSON.parse(exec.calls[0].params?.[1] as string);
    expect(payload).toEqual([
      {
        scope_first_observed: "global",
        kind: "hostname",
        value: "x.example",
      },
    ]);
  });

  it("writes an empty array for the empty exclusion set (NOT NULL contract)", async () => {
    const exec = makeExecutor();
    await recordExclusionSnapshot(exec as unknown as pg.Pool, "fp-empty", []);
    const payload = JSON.parse(exec.calls[0].params?.[1] as string);
    expect(payload).toEqual([]);
  });
});

describe("canonicalizePolicySnapshot", () => {
  it("renames `name` to `name_first_observed`, drops timestamps, sorts by id", () => {
    const policies: TriagePolicyRow[] = [
      {
        id: 7,
        name: "high-confidence-credentials",
        packet_attr: [],
        confidence: [],
        response: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
      {
        id: 2,
        name: "blocklist-mirror",
        packet_attr: [],
        confidence: [],
        response: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(canonicalizePolicySnapshot(policies)).toEqual([
      {
        id: 2,
        name_first_observed: "blocklist-mirror",
        packet_attr: [],
        confidence: [],
        response: [],
      },
      {
        id: 7,
        name_first_observed: "high-confidence-credentials",
        packet_attr: [],
        confidence: [],
        response: [],
      },
    ]);
  });
});

describe("recordPolicySnapshot", () => {
  it("INSERTs the canonical payload with ON CONFLICT DO NOTHING", async () => {
    const exec = makeExecutor();
    await recordPolicySnapshot(exec as unknown as pg.Pool, "policies-fp", [
      {
        id: 1,
        name: "p1",
        packet_attr: [],
        confidence: [],
        response: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].sql).toContain("INSERT INTO policy_snapshot");
    expect(exec.calls[0].sql).toContain("ON CONFLICT (fingerprint) DO NOTHING");
    expect(exec.calls[0].params?.[0]).toBe("policies-fp");
    const payload = JSON.parse(exec.calls[0].params?.[1] as string);
    expect(payload).toEqual([
      {
        id: 1,
        name_first_observed: "p1",
        packet_attr: [],
        confidence: [],
        response: [],
      },
    ]);
  });
});

describe("recordBaselineVersionSnapshot", () => {
  it("INSERTs (version, parameters) with ON CONFLICT (version) DO NOTHING", async () => {
    const exec = makeExecutor();
    const params = {
      selectorWeights: {
        w_S1: 1,
        w_S2: 1.5,
        w_S3: 0.8,
        w_S4: 0.8,
        w_UNLABELED: 0.5,
      },
      selectorSaturation: { R: 10, C: 4 },
      tagThresholds: { s1_high: 0.85, s3_recurring: 0.5, s4_correlated: 0.5 },
      slotAllocation: { base_share: 0.02, alpha: 1, beta: 0.1 },
      finalCount: { LOWER_FLOOR: 20, scale: 30, MIN_NONZERO_FLOOR: 1 },
      statisticsWindowDays: [7, 14, 30],
      maxTags: 5,
      selectorTags: {
        S1_HIGH: "S1-high",
        S2_SEVERE: "S2-severe",
        S3_RECURRING: "S3-recurring",
        S4_CORRELATED: "S4-correlated",
        UNLABELED_CLUSTER: "unlabeled-cluster",
      },
    };
    await recordBaselineVersionSnapshot(
      exec as unknown as pg.Pool,
      "phase1b-four-selector",
      params,
    );
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].sql).toContain(
      "INSERT INTO baseline_version_snapshot",
    );
    expect(exec.calls[0].sql).toContain("ON CONFLICT (version) DO NOTHING");
    expect(exec.calls[0].params?.[0]).toBe("phase1b-four-selector");
    expect(JSON.parse(exec.calls[0].params?.[1] as string)).toEqual(params);
  });
});
