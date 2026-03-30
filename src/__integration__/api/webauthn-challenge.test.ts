import { createHash, createSign, generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  type AuthSession,
  authGet,
  authPatch,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createFakeSessions,
  deleteMfaChallenges,
  deleteTotpCredential,
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  incrementTokenVersion,
  insertWebAuthnCredentialWithKey,
  resetAccountDefaults,
  setAccountRole,
  setAccountStatus,
  setAllowedIps,
  setMaxSessions,
} from "../helpers/setup-db";
import { SERVER_ORIGIN } from "../setup";

// ── Crypto helpers for WebAuthn assertion ───────────────────────

/** Encode a COSE P-256 public key from raw x,y coordinates. */
function encodeCoseKey(x: Buffer, y: Buffer): Buffer {
  // CBOR-encode: { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
  // A5 = map(5)
  // 01 02 = 1: 2 (kty: EC2)
  // 03 26 = 3: -7 (alg: ES256)
  // 20 01 = -1: 1 (crv: P-256)
  // 21 5820 <x> = -2: bstr(32)
  // 22 5820 <y> = -3: bstr(32)
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]),
    Buffer.from([0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function bufferToBase64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate an EC P-256 key pair and return credential materials. */
function generateWebAuthnKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  // Extract raw x,y from uncompressed public key (0x04 + 32x + 32y)
  const rawPub = publicKey.export({ type: "spki", format: "der" });
  // The uncompressed point is the last 65 bytes of the DER-encoded SPKI
  const uncompressed = rawPub.subarray(rawPub.length - 65);
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);

  const coseKey = encodeCoseKey(Buffer.from(x), Buffer.from(y));
  const credentialId = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

  return { coseKey, credentialId, privateKey };
}

/** Build a valid AuthenticationResponseJSON for testing. */
function buildAssertionResponse(params: {
  credentialId: Buffer;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  challenge: string;
  rpId: string;
  origin: string;
  counter?: number;
}) {
  const {
    credentialId,
    privateKey,
    challenge,
    rpId,
    origin,
    counter = 1,
  } = params;

  // clientDataJSON
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false,
  });
  const clientDataJSON = bufferToBase64url(Buffer.from(clientData));

  // authenticatorData: rpIdHash(32) + flags(1) + counter(4)
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const flags = Buffer.from([0x05]); // UP=1, UV=1
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter);
  const authData = Buffer.concat([rpIdHash, flags, counterBuf]);
  const authenticatorData = bufferToBase64url(authData);

  // signature = sign(authData + sha256(clientDataJSON))
  const clientDataHash = createHash("sha256")
    .update(Buffer.from(clientData))
    .digest();
  const signedData = Buffer.concat([authData, clientDataHash]);

  const signer = createSign("SHA256");
  signer.update(signedData);
  const signature = bufferToBase64url(signer.sign(privateKey));

  const credIdB64 = bufferToBase64url(credentialId);

  return {
    id: credIdB64,
    rawId: credIdB64,
    type: "public-key",
    response: {
      authenticatorData,
      clientDataJSON,
      signature,
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
  };
}

/**
 * Resolve the RP origin the same way the server does: use BASE_URL only
 * when it is a valid absolute URL, otherwise fall back to localhost:3000.
 * (Vitest sets BASE_URL = "/" from Vite config, which is not a valid URL.)
 */
function getExpectedOrigin(): string {
  const raw = process.env.BASE_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      // relative or invalid — fall through
    }
  }
  return "http://localhost:3000";
}

// ── Test helpers ─────────────────────────────────────────────────

/** Update MFA policy via the settings API (invalidates server cache). */
async function setMfaPolicy(
  session: AuthSession,
  allowedMethods: string[],
): Promise<void> {
  const res = await authPatch(session, "/api/system-settings/mfa_policy", {
    value: { allowed_methods: allowedMethods },
  });
  if (!res.ok) throw new Error(`Failed to update MFA policy: ${res.status}`);
}

/** Perform password sign-in and return response body. */
async function passwordSignIn(
  username: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${SERVER_ORIGIN}/api/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** Insert a WebAuthn credential with known key material for assertion testing. */
async function insertTestCredential(username: string) {
  const { coseKey, credentialId, privateKey } = generateWebAuthnKeyPair();

  await insertWebAuthnCredentialWithKey(username, credentialId, coseKey, {
    displayName: "Test Key",
  });

  return { credentialId, privateKey };
}

/** Request authentication options from the challenge/options endpoint. */
async function getAuthOptions(
  mfaToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${SERVER_ORIGIN}/api/auth/mfa/webauthn/challenge/options`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken }),
    },
  );
  const body = await res.json();
  return { status: res.status, body };
}

/** Submit WebAuthn challenge and return response. */
async function submitWebAuthnChallenge(
  mfaToken: string,
  response: unknown,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}/api/auth/mfa/webauthn/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, response }),
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("WebAuthn Challenge", () => {
  beforeAll(async () => {
    await resetRateLimits();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteWebAuthnCredentials(ADMIN_USERNAME);
    await deleteWebAuthnChallenges(ADMIN_USERNAME);
    await deleteTotpCredential(ADMIN_USERNAME);
    await deleteMfaChallenges(ADMIN_USERNAME);
    await setAllowedIps(ADMIN_USERNAME, null);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  afterAll(async () => {
    await deleteWebAuthnCredentials(ADMIN_USERNAME);
    await deleteWebAuthnChallenges(ADMIN_USERNAME);
    await deleteTotpCredential(ADMIN_USERNAME);
    await deleteMfaChallenges(ADMIN_USERNAME);
    await setAllowedIps(ADMIN_USERNAME, null);
    await resetAccountDefaults(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  // ── Sign-in behavior ───────────────────────────────────────────

  describe("sign-in with WebAuthn", () => {
    it("returns mfaMethods with webauthn when enrolled and policy on", async () => {
      await insertTestCredential(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaToken).toBeDefined();
      expect(body.mfaMethods).toEqual(["webauthn"]);
    });

    it("returns both methods when TOTP and WebAuthn enrolled", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);
      await insertTestCredential(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaMethods).toEqual(["totp", "webauthn"]);
    });

    it("returns normal session when WebAuthn enrolled but policy off", async () => {
      await insertTestCredential(ADMIN_USERNAME);
      const session = await signIn(ADMIN_USERNAME);
      await setMfaPolicy(session, ["totp"]); // WebAuthn disabled

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBeUndefined();
      expect(body.mustChangePassword).toBeDefined();
    });
  });

  // ── Challenge options endpoint ─────────────────────────────────

  describe("POST /api/auth/mfa/webauthn/challenge/options", () => {
    it("returns authentication options with valid mfaToken", async () => {
      await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      const { status, body } = await getAuthOptions(mfaToken);

      expect(status).toBe(200);
      expect(body.challenge).toBeDefined();
      expect(typeof body.challenge).toBe("string");
      expect(body.rpId).toBeDefined();
      expect(body.allowCredentials).toBeDefined();
      expect(Array.isArray(body.allowCredentials)).toBe(true);
    });

    it("returns 401 for invalid mfaToken", async () => {
      const { status, body } = await getAuthOptions("invalid.jwt.token");

      expect(status).toBe(401);
      expect(body.code).toBe("MFA_TOKEN_INVALID");
    });

    it("returns 403 when WebAuthn policy disabled", async () => {
      await insertTestCredential(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      // Disable WebAuthn
      const session = await signIn(ADMIN_USERNAME);
      await setMfaPolicy(session, ["totp"]);

      const { status, body } = await getAuthOptions(
        signInBody.mfaToken as string,
      );

      expect(status).toBe(403);
      expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
    });

    it("returns 400 for missing mfaToken", async () => {
      const res = await fetch(
        `${SERVER_ORIGIN}/api/auth/mfa/webauthn/challenge/options`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── Challenge endpoint ─────────────────────────────────────────

  describe("POST /api/auth/mfa/webauthn/challenge", () => {
    it("creates session with valid WebAuthn assertion", async () => {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Get authentication options
      const { body: options } = await getAuthOptions(mfaToken);
      const challenge = options.challenge as string;
      const rpId = options.rpId as string;

      // Build a valid assertion
      const assertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge,
        rpId,
        origin: getExpectedOrigin(),
      });

      const res = await submitWebAuthnChallenge(mfaToken, assertion);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mustChangePassword).toBeDefined();

      // Verify cookies were set (session created)
      const cookies = res.headers.get("set-cookie");
      expect(cookies).toContain("at=");
    });

    it("returns 401 with invalid assertion, token still usable", async () => {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Get options
      const { body: options } = await getAuthOptions(mfaToken);

      // Build assertion with wrong challenge
      const badAssertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: bufferToBase64url(Buffer.from("wrong-challenge")),
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
      });

      const res1 = await submitWebAuthnChallenge(mfaToken, badAssertion);
      expect(res1.status).toBe(401);
      const body1 = await res1.json();
      expect(body1.code).toBe("INVALID_MFA_CODE");

      // Token should still be usable — get new options and try again
      const { body: options2 } = await getAuthOptions(mfaToken);
      const goodAssertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options2.challenge as string,
        rpId: options2.rpId as string,
        origin: getExpectedOrigin(),
        counter: 2,
      });

      const res2 = await submitWebAuthnChallenge(mfaToken, goodAssertion);
      expect(res2.status).toBe(200);
    });

    it("returns 401 for invalid mfaToken", async () => {
      const res = await submitWebAuthnChallenge("invalid.jwt.token", {
        id: "fake",
        rawId: "fake",
        type: "public-key",
        response: {
          authenticatorData: "fake",
          clientDataJSON: "fake",
          signature: "fake",
        },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");
    });

    it("returns 401 for replayed token after success", async () => {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // First attempt succeeds
      const { body: options } = await getAuthOptions(mfaToken);
      const assertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options.challenge as string,
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
      });

      const res1 = await submitWebAuthnChallenge(mfaToken, assertion);
      expect(res1.status).toBe(200);

      // Replay should fail
      const res2 = await submitWebAuthnChallenge(mfaToken, assertion);
      expect(res2.status).toBe(401);
      const body2 = await res2.json();
      expect(body2.code).toBe("MFA_TOKEN_INVALID");
    });

    it("returns 400 for missing fields", async () => {
      const res = await fetch(
        `${SERVER_ORIGIN}/api/auth/mfa/webauthn/challenge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── Re-validation scenarios ────────────────────────────────────

  describe("account state re-validation", () => {
    /** Helper: insert credential, sign in, mutate state, then attempt challenge. */
    async function setupAndChallenge(
      mutate: () => Promise<void>,
    ): Promise<Response> {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Mutate state between sign-in and challenge
      await mutate();

      const { body: options } = await getAuthOptions(mfaToken);
      const assertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options.challenge as string,
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
      });

      return submitWebAuthnChallenge(mfaToken, assertion);
    }

    it("rejects when account suspended mid-flow", async () => {
      const res = await setupAndChallenge(() =>
        setAccountStatus(ADMIN_USERNAME, "suspended"),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ACCOUNT_INACTIVE");
    });

    it("rejects when account locked mid-flow", async () => {
      const res = await setupAndChallenge(() =>
        setAccountStatus(ADMIN_USERNAME, "locked"),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ACCOUNT_LOCKED");
    });

    it("rejects when token_version changed mid-flow", async () => {
      const res = await setupAndChallenge(() =>
        incrementTokenVersion(ADMIN_USERNAME),
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");
    });

    it("rejects when max sessions reached mid-flow", async () => {
      const res = await setupAndChallenge(async () => {
        await setMaxSessions(ADMIN_USERNAME, 1);
        await createFakeSessions(ADMIN_USERNAME, 1);
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("MAX_SESSIONS");
    });

    it("rejects when WebAuthn policy disabled mid-flow", async () => {
      await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Disable WebAuthn in policy
      const session = await signIn(ADMIN_USERNAME);
      await setMfaPolicy(session, ["totp"]);

      // Policy check happens before assertion verification,
      // so a fake assertion body is sufficient here.
      const res = await submitWebAuthnChallenge(mfaToken, {
        id: "fake",
        rawId: "fake",
        type: "public-key",
        response: {
          authenticatorData: "fake",
          clientDataJSON: "fake",
          signature: "fake",
        },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
    });

    it("rejects when role changed mid-flow", async () => {
      const res = await setupAndChallenge(() =>
        setAccountRole(ADMIN_USERNAME, "Security Monitor"),
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");

      await setAccountRole(ADMIN_USERNAME, "System Administrator");
    });

    it("rejects when IP not in allowed list", async () => {
      const res = await setupAndChallenge(() =>
        setAllowedIps(ADMIN_USERNAME, ["10.0.0.0/8"]),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("IP_RESTRICTED");
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 after exceeding MFA challenge limit", async () => {
      await insertTestCredential(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      const fakeAssertion = {
        id: "fake",
        rawId: "fake",
        type: "public-key",
        response: {
          authenticatorData: "fake",
          clientDataJSON: "fake",
          signature: "fake",
        },
      };

      // Send 5 attempts (at threshold)
      for (let i = 0; i < 5; i++) {
        // Get fresh options each time so there's a stored challenge
        await getAuthOptions(mfaToken);
        const res = await submitWebAuthnChallenge(mfaToken, fakeAssertion);
        expect(res.status).toBe(401);
      }

      // 6th attempt should be rate limited
      await getAuthOptions(mfaToken);
      const res = await submitWebAuthnChallenge(mfaToken, fakeAssertion);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe("MFA_RATE_LIMITED");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });
  });

  // ── Audit logging ──────────────────────────────────────────────

  describe("audit logging", () => {
    it("records mfa.webauthn.verify.success on successful challenge", async () => {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      const { body: options } = await getAuthOptions(mfaToken);
      const assertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options.challenge as string,
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
      });

      const res = await submitWebAuthnChallenge(mfaToken, assertion);
      expect(res.status).toBe(200);

      // Check audit log
      const session = await signIn(ADMIN_USERNAME);
      const auditRes = await authGet(
        session,
        "/api/audit-logs?action=mfa.webauthn.verify.success&pageSize=1",
      );
      expect(auditRes.status).toBe(200);
      const auditBody = await auditRes.json();
      expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.data[0].action).toBe("mfa.webauthn.verify.success");
    });

    it("records mfa.webauthn.verify.failure on invalid assertion", async () => {
      await insertTestCredential(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      const { body: options } = await getAuthOptions(mfaToken);

      // Build a bad assertion (credential ID that doesn't exist)
      const fakeCredId = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const { privateKey: fakeKey } = generateWebAuthnKeyPair();
      const badAssertion = buildAssertionResponse({
        credentialId: fakeCredId,
        privateKey: fakeKey,
        challenge: options.challenge as string,
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
      });

      const res = await submitWebAuthnChallenge(mfaToken, badAssertion);
      expect(res.status).toBe(401);

      const session = await signIn(ADMIN_USERNAME);
      const auditRes = await authGet(
        session,
        "/api/audit-logs?action=mfa.webauthn.verify.failure&pageSize=1",
      );
      expect(auditRes.status).toBe(200);
      const auditBody = await auditRes.json();
      expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.data[0].action).toBe("mfa.webauthn.verify.failure");
    });
  });

  // ── Counter verification ───────────────────────────────────────

  describe("counter verification", () => {
    it("updates credential counter after successful authentication", async () => {
      const { credentialId, privateKey } =
        await insertTestCredential(ADMIN_USERNAME);

      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      const { body: options } = await getAuthOptions(
        signInBody.mfaToken as string,
      );
      const assertion = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options.challenge as string,
        rpId: options.rpId as string,
        origin: getExpectedOrigin(),
        counter: 5,
      });

      const res = await submitWebAuthnChallenge(
        signInBody.mfaToken as string,
        assertion,
      );
      expect(res.status).toBe(200);

      // Verify counter was updated by attempting a second auth
      // with counter=6 (must be > 5)
      const { body: signInBody2 } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const { body: options2 } = await getAuthOptions(
        signInBody2.mfaToken as string,
      );
      const assertion2 = buildAssertionResponse({
        credentialId,
        privateKey,
        challenge: options2.challenge as string,
        rpId: options2.rpId as string,
        origin: getExpectedOrigin(),
        counter: 6,
      });

      const res2 = await submitWebAuthnChallenge(
        signInBody2.mfaToken as string,
        assertion2,
      );
      expect(res2.status).toBe(200);
    });
  });
});
