import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-aimer-analyze-envelope");
const dataDir = path.join(tmpDir, "data");

function sha256Base64Url(data: Uint8Array): string {
  return createHash("sha256")
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("analyze-envelope helpers (#629)", () => {
  let signingKey: typeof import("@/lib/aimer/signing-key");
  let mod: typeof import("@/lib/aimer/analyze-envelope");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";
    signingKey = await import("@/lib/aimer/signing-key");
    mod = await import("@/lib/aimer/analyze-envelope");
    signingKey.deleteAimerSigningKeyFile();
    await signingKey.generateAimerSigningKey();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("localeToAnalyzeLang", () => {
    it('maps "ko" to "KOREAN"', () => {
      expect(mod.localeToAnalyzeLang("ko")).toBe("KOREAN");
    });

    it("ignores case when mapping to KOREAN", () => {
      expect(mod.localeToAnalyzeLang("KO")).toBe("KOREAN");
    });

    it('maps "en" to "ENGLISH"', () => {
      expect(mod.localeToAnalyzeLang("en")).toBe("ENGLISH");
    });

    it("defaults to ENGLISH for unknown locales", () => {
      expect(mod.localeToAnalyzeLang("fr")).toBe("ENGLISH");
      expect(mod.localeToAnalyzeLang("")).toBe("ENGLISH");
    });
  });

  describe("ANALYZE_EVENT_KEY_PATTERN", () => {
    it("accepts unsigned decimal up to 39 digits", () => {
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("1")).toBe(true);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("12345")).toBe(true);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("9".repeat(39))).toBe(true);
    });

    it("rejects 40 digits, signs, and non-numerics", () => {
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("9".repeat(40))).toBe(false);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("-1")).toBe(false);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("1.0")).toBe(false);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("abc")).toBe(false);
      expect(mod.ANALYZE_EVENT_KEY_PATTERN.test("")).toBe(false);
    });
  });

  describe("sha256Base64Url", () => {
    it("matches a manual base64url(sha256(bytes)) computation", () => {
      const bytes = new TextEncoder().encode('{"event_key":"42"}');
      expect(mod.sha256Base64Url(bytes)).toBe(sha256Base64Url(bytes));
    });

    it("produces output without base64 padding or non-url-safe chars", () => {
      const out = mod.sha256Base64Url(new TextEncoder().encode("anything"));
      expect(out).not.toMatch(/[+/=]/);
    });
  });

  describe("eventsEnvelopeHash", () => {
    it("hashes the UTF-8 bytes of the JWS compact serialization", () => {
      const jws = "header.payload.signature";
      const expected = sha256Base64Url(Buffer.from(jws, "utf8"));
      expect(mod.eventsEnvelopeHash(jws)).toBe(expected);
    });
  });

  describe("eventToSnakeCase", () => {
    it("maps __typename to top-level kind and strips the original key", () => {
      const out = mod.eventToSnakeCase({
        __typename: "HttpThreat",
        time: "2026-05-21T00:00:00Z",
      });
      expect(out.kind).toBe("HttpThreat");
      expect(out.__typename).toBeUndefined();
      expect(out.time).toBe("2026-05-21T00:00:00Z");
    });

    it("converts camelCase keys to snake_case", () => {
      const out = mod.eventToSnakeCase({
        origAddr: "10.0.0.1",
        respPort: 443,
        dnsQueryName: "example.com",
      });
      expect(out).toEqual({
        orig_addr: "10.0.0.1",
        resp_port: 443,
        dns_query_name: "example.com",
      });
    });

    it("recurses into nested objects and arrays", () => {
      const out = mod.eventToSnakeCase({
        nestedField: { innerKey: 1, deeperObject: { evenDeeper: "x" } },
        arrayField: [{ itemKey: "a" }, { itemKey: "b" }],
      });
      expect(out).toEqual({
        nested_field: { inner_key: 1, deeper_object: { even_deeper: "x" } },
        array_field: [{ item_key: "a" }, { item_key: "b" }],
      });
    });

    it("preserves null and undefined values", () => {
      const out = mod.eventToSnakeCase({ origAddr: null, respPort: undefined });
      expect(out).toEqual({ orig_addr: null, resp_port: undefined });
    });
  });

  describe("signAnalyzeParamsToken", () => {
    function baseClaims(): import("@/lib/aimer/analyze-envelope").AnalyzeParamsTokenClaims {
      return {
        context_jti: "11111111-2222-3333-4444-555555555555",
        payload_hash: sha256Base64Url(new TextEncoder().encode("payload")),
        envelope_hash: sha256Base64Url(new TextEncoder().encode("envelope")),
        event_key: "12345",
        lang: "KOREAN",
        model_name: "anthropic",
        model: "claude-sonnet-4-6",
        force: false,
        external_key: "acmecorp.com",
      };
    }

    it("signs a JWS that round-trips through jose with the active kid", async () => {
      const iat = Math.floor(Date.now() / 1000);
      const claims = baseClaims();
      const jws = await mod.signAnalyzeParamsToken(claims, {
        iss: "aice.example.com",
        iat,
        exp: iat + 60,
      });

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
        issuer: "aice.example.com",
      });
      expect(payload.context_jti).toBe(claims.context_jti);
      expect(payload.payload_hash).toBe(claims.payload_hash);
      expect(payload.envelope_hash).toBe(claims.envelope_hash);
      expect(payload.event_key).toBe(claims.event_key);
      expect(payload.lang).toBe(claims.lang);
      expect(payload.model_name).toBe(claims.model_name);
      expect(payload.model).toBe(claims.model);
      expect(payload.force).toBe(false);
      expect(payload.external_key).toBe(claims.external_key);
      expect(payload.iat).toBe(iat);
      expect(payload.exp).toBe(iat + 60);
    });

    it("carries force=true unchanged through the JWS", async () => {
      const iat = Math.floor(Date.now() / 1000);
      const jws = await mod.signAnalyzeParamsToken(
        { ...baseClaims(), force: true },
        { iss: "aice.example.com", iat, exp: iat + 60 },
      );
      const status = await signingKey.getAimerSigningKeyStatus();
      if (!status.active) throw new Error("expected active key");
      const verifyKey = await importJWK(
        status.active.publicJwk,
        status.active.algorithm,
      );
      const { payload } = await jwtVerify(jws, verifyKey, {
        issuer: "aice.example.com",
      });
      expect(payload.force).toBe(true);
    });

    it("throws when no active signing key is on disk", async () => {
      signingKey.deleteAimerSigningKeyFile();
      const iat = Math.floor(Date.now() / 1000);
      await expect(
        mod.signAnalyzeParamsToken(baseClaims(), {
          iss: "aice.example.com",
          iat,
          exp: iat + 60,
        }),
      ).rejects.toThrow(/No active Aimer signing key/);
    });
  });
});
