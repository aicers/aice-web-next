import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-aimer-events-envelope");
const dataDir = path.join(tmpDir, "data");

function sha256Base64Url(data: Uint8Array): string {
  return createHash("sha256")
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("aimer events-envelope signing", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");
  let mod: typeof import("@/lib/aimer/events-envelope");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";
    signingKey = await import("@/lib/aimer/signing-key");
    mod = await import("@/lib/aimer/events-envelope");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function baseInput() {
    const iat = Math.floor(Date.now() / 1000);
    return {
      iss: "aice.example.com",
      aice_id: "aice.example.com",
      customer_ids: ["acmecorp.com"],
      schema_version: "analyze-bridge.v1" as const,
      event_count: 1,
      iat,
      exp: iat + 60,
      context_jti: "11111111-2222-3333-4444-555555555555",
    };
  }

  it("signs a JWS that round-trips through jose with the active kid", async () => {
    const input = baseInput();
    const eventsData = new TextEncoder().encode('{"event_key":"1"}');
    const jws = await mod.signEventsEnvelope(input, eventsData);

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const header = decodeProtectedHeader(jws);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(status.active.kid);

    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(jws, verifyKey, {
      issuer: input.iss,
    });
    expect(payload.aice_id).toBe(input.aice_id);
    expect(payload.customer_ids).toEqual(input.customer_ids);
    expect(payload.schema_version).toBe(input.schema_version);
    expect(payload.event_count).toBe(input.event_count);
    expect(payload.context_jti).toBe(input.context_jti);
    expect(payload.payload_hash).toBe(sha256Base64Url(eventsData));
    expect(payload.iat).toBe(input.iat);
    expect(payload.exp).toBe(input.exp);
  });

  it("computes payload_hash from the bytes (signer-derived, not caller-supplied)", async () => {
    const input = baseInput();
    const a = await mod.signEventsEnvelope(
      input,
      new TextEncoder().encode("payload-A"),
    );
    const b = await mod.signEventsEnvelope(
      input,
      new TextEncoder().encode("payload-B"),
    );

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload: pa } = await jwtVerify(a, verifyKey, {
      issuer: input.iss,
    });
    const { payload: pb } = await jwtVerify(b, verifyKey, {
      issuer: input.iss,
    });
    expect(pa.payload_hash).toBe(
      sha256Base64Url(new TextEncoder().encode("payload-A")),
    );
    expect(pb.payload_hash).toBe(
      sha256Base64Url(new TextEncoder().encode("payload-B")),
    );
    expect(pa.payload_hash).not.toBe(pb.payload_hash);
  });

  it("includes cursor_event_time + cursor_quality on the JWT payload when supplied (Phase 0.5 watermark, #644)", async () => {
    const input = {
      ...baseInput(),
      schema_version: "phase2.baseline.v1" as const,
      cursor_event_time: "2026-05-25T12:34:56.789Z",
      cursor_quality: "strict" as const,
    };
    const eventsData = new TextEncoder().encode('{"events":[]}');
    const jws = await mod.signEventsEnvelope(input, eventsData);

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(jws, verifyKey, { issuer: input.iss });
    expect(payload.cursor_event_time).toBe("2026-05-25T12:34:56.789Z");
    expect(payload.cursor_quality).toBe("strict");
  });

  it("omits cursor_event_time + cursor_quality when neither is supplied", async () => {
    const input = baseInput();
    const eventsData = new TextEncoder().encode('{"event_key":"1"}');
    const jws = await mod.signEventsEnvelope(input, eventsData);

    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    const { payload } = await jwtVerify(jws, verifyKey, { issuer: input.iss });
    expect(payload).not.toHaveProperty("cursor_event_time");
    expect(payload).not.toHaveProperty("cursor_quality");
  });

  it("omits both watermark fields when only one is supplied (half-claim guard)", async () => {
    // A bare `cursor_event_time` with no `cursor_quality` (or vice
    // versa) is uninterpretable on the verify side. The signer must
    // emit both or neither.
    const halfA = {
      ...baseInput(),
      cursor_event_time: "2026-05-25T12:34:56.789Z",
    };
    const halfB = {
      ...baseInput(),
      cursor_quality: "soft" as const,
    };
    const eventsData = new TextEncoder().encode('{"event_key":"1"}');
    const status = await signingKey.getAimerSigningKeyStatus();
    if (!status.active) throw new Error("expected active key");
    const verifyKey = await importJWK(
      status.active.publicJwk,
      status.active.algorithm,
    );
    for (const half of [halfA, halfB]) {
      const jws = await mod.signEventsEnvelope(half, eventsData);
      const { payload } = await jwtVerify(jws, verifyKey, { issuer: half.iss });
      expect(payload).not.toHaveProperty("cursor_event_time");
      expect(payload).not.toHaveProperty("cursor_quality");
    }
  });

  it("throws when no active signing key is on disk", async () => {
    signingKey.deleteAimerSigningKeyFile();
    await expect(
      mod.signEventsEnvelope(
        baseInput(),
        new TextEncoder().encode('{"event_key":"1"}'),
      ),
    ).rejects.toThrow(/No active Aimer signing key/);
  });
});
