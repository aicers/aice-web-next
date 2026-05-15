import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

// Keep the signing-key scratch directory outside `src/` so the
// repo-wide source-file scanner in
// `src/__tests__/lib/node/apply-attempts-public-surface.test.ts` cannot
// race against our `beforeEach` / `afterEach` mkdir / rm.
const tmpDir = path.join(
  tmpdir(),
  `aice-web-next-phase2-orchestrate-${randomUUID()}`,
);
const dataDir = path.join(tmpDir, "data");

function sha256Base64Url(data: Uint8Array): string {
  return createHash("sha256")
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function baselinePayload(extra: Record<string, unknown> = {}) {
  return {
    source_aice_id: "aice.example.com",
    baseline_version: "1.B.0",
    events: [
      {
        event_key: "12345678901234567890",
        event_time: "2026-05-10T00:00:00Z",
        kind: "HttpThreat",
      },
      {
        event_key: "98765432109876543210",
        event_time: "2026-05-10T00:01:00Z",
        kind: "HttpThreat",
      },
    ],
    ...extra,
  };
}

describe("buildPhase2Push (Phase 2 orchestration helper)", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");
  let mod: typeof import("@/lib/aimer/phase2/orchestrate");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";

    signingKey = await import("@/lib/aimer/signing-key");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();

    mod = await import("@/lib/aimer/phase2/orchestrate");

    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    mockQuery.mockReset().mockResolvedValue({
      rows: [{ id: 42, external_key: "acmecorp.com" }],
      rowCount: 1,
    });
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Sentinel constant ────────────────────────────────────────

  it("exports SYSTEM_ACTOR_ACCOUNT_ID as the documented all-zero UUID", () => {
    expect(mod.SYSTEM_ACTOR_ACCOUNT_ID).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
  });

  // ── Happy path ────────────────────────────────────────────────

  it("produces multipart components that verifyContextToken / verifyEventsEnvelope accept", async () => {
    const result = await mod.buildPhase2Push({
      schemaVersion: "phase2.baseline.v1",
      customerId: 42,
      accountId: "account-1",
      payload: baselinePayload(),
    });

    expect(typeof result.context_token).toBe("string");
    expect(typeof result.events_envelope).toBe("string");
    expect(typeof result.events_data).toBe("string");
    expect(typeof result.context_jti).toBe("string");

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );

    // Context-token verification (signature, iss, aud).
    const ctxHeader = decodeProtectedHeader(result.context_token);
    expect(ctxHeader.alg).toBe("ES256");
    expect(ctxHeader.kid).toBe(status.active.kid);
    const { payload: ctx } = await jwtVerify(result.context_token, verifyKey, {
      issuer: "aice.example.com",
      audience: "aimer-web",
    });
    expect(ctx.sub).toBe("account-1");
    expect(ctx.customer_ids).toEqual(["acmecorp.com"]);
    expect(ctx.jti).toBe(result.context_jti);
    expect((ctx.exp ?? 0) - (ctx.iat ?? 0)).toBe(60);

    // Events-envelope verification (signature, payload_hash binds to bytes).
    const { payload: env } = await jwtVerify(
      result.events_envelope,
      verifyKey,
      { issuer: "aice.example.com" },
    );
    expect(env.context_jti).toBe(ctx.jti);
    expect(env.aice_id).toBe("aice.example.com");
    expect(env.customer_ids).toEqual(["acmecorp.com"]);
    expect(env.schema_version).toBe("phase2.baseline.v1");
    expect(env.event_count).toBe(2);
    expect(env.iat).toBe(ctx.iat);
    expect(env.exp).toBe(ctx.exp);
    expect(env.payload_hash).toBe(
      sha256Base64Url(new TextEncoder().encode(result.events_data)),
    );
  });

  it("resolves customer external_key and threads it into customer_ids[] AND payload.external_key", async () => {
    const result = await mod.buildPhase2Push({
      schemaVersion: "phase2.baseline.v1",
      customerId: 42,
      accountId: "account-1",
      payload: baselinePayload(),
    });

    const data = JSON.parse(result.events_data) as { external_key: string };
    expect(data.external_key).toBe("acmecorp.com");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM customers WHERE id = $1"),
      [42],
    );
  });

  it("overwrites a caller-supplied payload.external_key with the resolved value", async () => {
    const result = await mod.buildPhase2Push({
      schemaVersion: "phase2.baseline.v1",
      customerId: 42,
      accountId: "account-1",
      payload: baselinePayload({ external_key: "wrong.example.com" }),
    });
    const data = JSON.parse(result.events_data) as { external_key: string };
    expect(data.external_key).toBe("acmecorp.com");
  });

  // ── event_count computation per RFC 0002 §6.1 ────────────────

  it("event_count matches events.length for baseline.v1", async () => {
    const result = await mod.buildPhase2Push({
      schemaVersion: "phase2.baseline.v1",
      customerId: 42,
      accountId: "account-1",
      payload: baselinePayload(),
    });
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(result.events_envelope, verifyKey);
    expect(payload.event_count).toBe(2);
  });

  it("event_count counts withdrawals[*] correctly across keyed and single-item kinds", async () => {
    const result = await mod.buildPhase2Push({
      schemaVersion: "phase2.withdraw.v1",
      customerId: 42,
      accountId: "account-1",
      payload: {
        withdrawals: [
          {
            kind: "baseline_event",
            baseline_version: "1.B.0",
            event_keys: ["1", "2", "3"],
          },
          { kind: "story", story_id: "100", story_version: "v1" },
          { kind: "policy_event", run_id: "9", event_keys: ["4", "5"] },
        ],
      },
    });
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(result.events_envelope, verifyKey);
    // 3 (baseline event_keys) + 1 (story) + 2 (policy event_keys) = 6
    expect(payload.event_count).toBe(6);
  });

  // ── Schema-invalid payload is rejected before signing ────────

  it("rejects schema-invalid payloads before minting tokens", async () => {
    const { Phase2PayloadValidationError } = await import(
      "@/lib/aimer/phase2/schemas"
    );
    await expect(
      mod.buildPhase2Push({
        schemaVersion: "phase2.baseline.v1",
        customerId: 42,
        accountId: "account-1",
        // Missing required `baseline_version` + `source_aice_id`.
        payload: { events: [] },
      }),
    ).rejects.toBeInstanceOf(Phase2PayloadValidationError);
  });

  // ── Setup gating ──────────────────────────────────────────────

  it("throws Phase2OrchestrationError when integration is not configured", async () => {
    mockGetSetup.mockResolvedValue({
      aiceId: null,
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    await expect(
      mod.buildPhase2Push({
        schemaVersion: "phase2.baseline.v1",
        customerId: 42,
        accountId: "account-1",
        payload: baselinePayload(),
      }),
    ).rejects.toMatchObject({ code: "aimer_integration_not_configured" });
  });

  it("throws when the customer row is missing", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(
      mod.buildPhase2Push({
        schemaVersion: "phase2.baseline.v1",
        customerId: 999,
        accountId: "account-1",
        payload: baselinePayload(),
      }),
    ).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("throws when the customer has no external_key", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 42, external_key: null }],
      rowCount: 1,
    });
    await expect(
      mod.buildPhase2Push({
        schemaVersion: "phase2.baseline.v1",
        customerId: 42,
        accountId: "account-1",
        payload: baselinePayload(),
      }),
    ).rejects.toMatchObject({ code: "customer_external_key_missing" });
  });
});
