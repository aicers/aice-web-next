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

  describe("eventToAnalyzeBridgeCanon", () => {
    it("maps __typename to top-level kind, drops the original key, and forces event_key", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "HttpThreat",
          time: "2026-05-21T00:00:00Z",
        },
        "42",
      );
      expect(out.kind).toBe("HttpThreat");
      expect(out.__typename).toBeUndefined();
      expect(out.event_time).toBe("2026-05-21T00:00:00Z");
      expect(out.time).toBeUndefined();
      expect(out.event_key).toBe("42");
    });

    it("applies the contract aliases time → event_time and query → dns_query", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "DnsCovertChannel",
          time: "2026-05-21T00:00:00Z",
          query: "evil.example.com",
        },
        "99",
      );
      expect(out.event_time).toBe("2026-05-21T00:00:00Z");
      expect(out.dns_query).toBe("evil.example.com");
      expect(out.query).toBeUndefined();
    });

    it("strips UI-only common-interface fields (id, confidence, level, triageScores)", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "HttpThreat",
          id: "42",
          confidence: 0.9,
          level: "MEDIUM",
          triageScores: [{ policyId: 1, score: 0.5 }],
          sensor: "sensor-1",
        },
        "42",
      );
      expect(out.id).toBeUndefined();
      expect(out.confidence).toBeUndefined();
      expect(out.level).toBeUndefined();
      expect(out.triage_scores).toBeUndefined();
      expect(out.sensor).toBe("sensor-1");
    });

    it("strips nested customer / network / country metadata", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "HttpThreat",
          origCustomer: { id: 1, name: "Acme" },
          respCustomer: { id: 2, name: "BizCo" },
          origCustomers: [{ id: 1, name: "Acme" }],
          respCustomers: [{ id: 2, name: "BizCo" }],
          origNetwork: { id: 3, name: "Office" },
          respNetwork: { id: 4, name: "DMZ" },
          origCountry: "US",
          respCountry: "KR",
          origCountries: ["US"],
          respCountries: ["KR"],
        },
        "42",
      );
      expect(out.orig_customer).toBeUndefined();
      expect(out.resp_customer).toBeUndefined();
      expect(out.orig_customers).toBeUndefined();
      expect(out.resp_customers).toBeUndefined();
      expect(out.orig_network).toBeUndefined();
      expect(out.resp_network).toBeUndefined();
      expect(out.orig_country).toBeUndefined();
      expect(out.resp_country).toBeUndefined();
      expect(out.orig_countries).toBeUndefined();
      expect(out.resp_countries).toBeUndefined();
    });

    it("snake-cases addressing fields the analyze-bridge canon keeps", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "HttpThreat",
          origAddr: "10.0.0.1",
          origPort: 1234,
          respAddr: "203.0.113.5",
          respPort: 443,
          proto: 6,
          host: "example.com",
          uri: "/login",
          category: "Webshell",
        },
        "42",
      );
      expect(out).toMatchObject({
        kind: "HttpThreat",
        event_key: "42",
        orig_addr: "10.0.0.1",
        orig_port: 1234,
        resp_addr: "203.0.113.5",
        resp_port: 443,
        proto: 6,
        host: "example.com",
        uri: "/login",
        category: "Webshell",
      });
    });

    it("snake-cases nested arrays of plain values (e.g. FtpPlainText.commands)", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "FtpPlainText",
          commands: [
            { command: "USER", replyCode: 331, replyMsg: "Password required" },
            { command: "PASS", replyCode: 230, replyMsg: "Login OK" },
          ],
        },
        "42",
      );
      expect(out.commands).toEqual([
        { command: "USER", reply_code: 331, reply_msg: "Password required" },
        { command: "PASS", reply_code: 230, reply_msg: "Login OK" },
      ]);
    });

    it("preserves null values on retained fields", () => {
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "HttpThreat",
          origAddr: null,
          respPort: null,
        },
        "42",
      );
      expect(out.orig_addr).toBeNull();
      expect(out.resp_port).toBeNull();
    });

    it("produces the same top-level addressing keys as the baseline canon", () => {
      // Baseline rows emit these keys at the top level (see
      // `loadSingleBaselineEventWireItem` in baseline-push.ts). The
      // non-baseline path must produce the same set so aimer-web's
      // verifier sees one canonical shape regardless of source.
      const baselineTopLevel = [
        "event_key",
        "event_time",
        "kind",
        "sensor",
        "orig_addr",
        "orig_port",
        "resp_addr",
        "resp_port",
        "proto",
        "host",
        "dns_query",
        "uri",
        "category",
      ];
      const out = mod.eventToAnalyzeBridgeCanon(
        {
          __typename: "DnsCovertChannel",
          time: "2026-05-21T00:00:00Z",
          sensor: "sensor-1",
          origAddr: "10.0.0.1",
          origPort: 53,
          respAddr: "8.8.8.8",
          respPort: 53,
          proto: 17,
          host: null,
          query: "covert.example.com",
          uri: null,
          category: "DNS",
        },
        "42",
      );
      for (const key of baselineTopLevel) {
        expect(out).toHaveProperty(key);
      }
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

    it("honours an explicit keyMaterial pin instead of re-reading the file", async () => {
      // Snapshot the active key, replace the on-disk file with a
      // freshly generated one (which the implicit loader would now
      // return), and confirm the explicit pin still signs with the
      // original kid. Catches the kid-drift race the envelope-mint
      // route prevents by loading once and threading.
      const pinned = signingKey.loadActiveSigningKeyMaterial();
      if (!pinned) throw new Error("expected active key");

      signingKey.deleteAimerSigningKeyFile();
      await signingKey.generateAimerSigningKey();
      const replaced = signingKey.loadActiveSigningKeyMaterial();
      if (!replaced) throw new Error("expected replacement key");
      expect(replaced.kid).not.toBe(pinned.kid);

      const iat = Math.floor(Date.now() / 1000);
      const jws = await mod.signAnalyzeParamsToken(baseClaims(), {
        iss: "aice.example.com",
        iat,
        exp: iat + 60,
        keyMaterial: pinned,
      });
      const header = decodeProtectedHeader(jws);
      expect(header.kid).toBe(pinned.kid);
      expect(header.kid).not.toBe(replaced.kid);
    });
  });
});
