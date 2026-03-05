// Edge Runtime compatible — no "server-only", no node:* imports, no DB

import type { CryptoKey, JWK, JWTPayload } from "jose";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

const JWT_ISSUER = "aice-web-next";
const JWT_AUDIENCE = "aice-web-next";

// ── Types ───────────────────────────────────────────────────────

export interface StatelessPayload extends JWTPayload {
  sub: string;
  sid: string;
  roles: string[];
  token_version: number;
  kid: string;
}

interface VerificationKeyEntry {
  kid: string;
  algorithm: string;
  publicKey: CryptoKey;
}

// ── Global state ────────────────────────────────────────────────
// Keys are stored on globalThis so they survive module
// re-instantiation across Next.js server chunks (the middleware
// bundle uses a separate module instance from the Node.js runtime).

const g = globalThis as unknown as {
  __jwtStatelessVerificationKeys?: VerificationKeyEntry[];
};

function getVerificationKeys(): VerificationKeyEntry[] {
  return g.__jwtStatelessVerificationKeys ?? [];
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Initialize stateless verification keys from JWK public keys.
 * Called once at startup (from middleware or server initialization).
 * Accepts raw JWK objects so no file I/O is needed.
 */
export async function initStatelessKeys(
  keys: Array<{ kid: string; algorithm: string; publicKey: JWK }>,
): Promise<void> {
  g.__jwtStatelessVerificationKeys = await Promise.all(
    keys.map(async (k) => ({
      kid: k.kid,
      algorithm: k.algorithm,
      publicKey: (await importJWK(k.publicKey, k.algorithm)) as CryptoKey,
    })),
  );
}

/**
 * Verify a JWT using only cryptographic checks (signature, exp, kid).
 * No database access — safe for Edge Runtime / Next.js middleware.
 */
export async function verifyJwtStateless(
  token: string,
): Promise<StatelessPayload> {
  const header = decodeProtectedHeader(token);
  const kid = header.kid;

  if (!kid) {
    throw new Error("JWT header missing kid");
  }

  const keyEntry = getVerificationKeys().find((k) => k.kid === kid);
  if (!keyEntry) {
    throw new Error(`No verification key found for kid: ${kid}`);
  }

  const { payload } = await jwtVerify<StatelessPayload>(
    token,
    keyEntry.publicKey,
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: [keyEntry.algorithm],
    },
  );

  return payload;
}
