import * as OTPAuth from "otpauth";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
} from "../helpers/auth";
import {
  deleteMfaChallenges,
  enrollAndVerifyTotp,
  resetAccountDefaults,
} from "../helpers/setup-db";
import { SERVER_ORIGIN } from "../setup";

function generateCode(secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "AICE",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate();
}

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

async function submitChallenge(
  mfaToken: string,
  code: string,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}/api/auth/mfa/totp/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
}

describe("MFA Challenge Rate Limiting", () => {
  let secret: string;

  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await deleteMfaChallenges(ADMIN_USERNAME);
  });

  it("blocks after per-account+IP limit (5 wrong codes)", async () => {
    // Each wrong code attempt: sign-in → get mfaToken → submit wrong code
    let blockedStatus = 0;
    for (let i = 0; i < 6; i++) {
      const signInResult = await passwordSignIn(ADMIN_USERNAME, ADMIN_PASSWORD);
      if (signInResult.status === 429) {
        blockedStatus = 429;
        break;
      }
      const mfaToken = signInResult.body.mfaToken as string;
      if (!mfaToken) break;

      const res = await submitChallenge(mfaToken, "000000");
      const resStatus = res.status;
      if (resStatus === 429) {
        blockedStatus = 429;
        break;
      }
    }

    expect(blockedStatus).toBe(429);
  });

  it("valid code succeeds within rate limit window", async () => {
    const signInResult = await passwordSignIn(ADMIN_USERNAME, ADMIN_PASSWORD);
    expect(signInResult.status).toBe(200);
    const mfaToken = signInResult.body.mfaToken as string;

    const validCode = generateCode(secret);
    const res = await submitChallenge(mfaToken, validCode);
    expect(res.status).toBe(200);
  });

  it("valid code still works after fewer than 5 failures", async () => {
    // 3 wrong attempts
    for (let i = 0; i < 3; i++) {
      const signInResult = await passwordSignIn(ADMIN_USERNAME, ADMIN_PASSWORD);
      const mfaToken = signInResult.body.mfaToken as string;
      if (mfaToken) {
        await submitChallenge(mfaToken, "000000");
      }
    }

    // Valid attempt should still succeed
    const signInResult = await passwordSignIn(ADMIN_USERNAME, ADMIN_PASSWORD);
    expect(signInResult.status).toBe(200);
    const mfaToken = signInResult.body.mfaToken as string;
    const validCode = generateCode(secret);
    const res = await submitChallenge(mfaToken, validCode);
    expect(res.status).toBe(200);
  });
});
