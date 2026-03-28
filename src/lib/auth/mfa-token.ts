import "server-only";

import type { JWTPayload } from "jose";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

import { getSigningKey, getVerificationKey } from "./jwt-keys";

// ── Constants ───────────────────────────────────────────────────

const JWT_ISSUER = "aice-web-next";
const JWT_AUDIENCE = "aice-web-next";
const MFA_TOKEN_EXPIRATION_MINUTES = 5;
const MFA_TOKEN_PURPOSE = "mfa_challenge";

// ── Types ───────────────────────────────────────────────────────

export interface MfaTokenPayload extends JWTPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  roles: string[];
  token_version: number;
  purpose: "mfa_challenge";
  kid: string;
}

// ── Issuance ────────────────────────────────────────────────────

export async function issueMfaToken(params: {
  accountId: string;
  roles: string[];
  tokenVersion: number;
  jti: string;
}): Promise<string> {
  const { accountId, roles, tokenVersion, jti } = params;
  const key = getSigningKey();

  return new SignJWT({
    roles,
    token_version: tokenVersion,
    purpose: MFA_TOKEN_PURPOSE,
    kid: key.kid,
  })
    .setProtectedHeader({ alg: key.algorithm, kid: key.kid })
    .setIssuer(JWT_ISSUER)
    .setSubject(accountId)
    .setAudience(JWT_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${MFA_TOKEN_EXPIRATION_MINUTES}m`)
    .sign(key.privateKey);
}

// ── Verification ────────────────────────────────────────────────

export async function verifyMfaToken(token: string): Promise<MfaTokenPayload> {
  const header = decodeProtectedHeader(token);
  const kid = header.kid;

  if (!kid) {
    throw new Error("JWT header missing kid");
  }

  const keyInfo = getVerificationKey(kid);
  if (!keyInfo) {
    throw new Error(`No verification key found for kid: ${kid}`);
  }

  const { payload } = await jwtVerify<MfaTokenPayload>(
    token,
    keyInfo.publicKey,
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: [keyInfo.algorithm],
    },
  );

  if (payload.purpose !== MFA_TOKEN_PURPOSE) {
    throw new Error("Invalid token purpose");
  }

  return payload;
}
