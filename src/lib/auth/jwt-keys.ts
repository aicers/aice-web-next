import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CryptoKey, JWK } from "jose";
import { exportJWK, generateKeyPair, importJWK } from "jose";

import { getDataDir } from "./data-dir";

// ── Types ───────────────────────────────────────────────────────

interface JwtKeyFile {
  kid: string;
  algorithm: string;
  privateKey: JWK;
  publicKey: JWK;
}

interface LoadedKeyPair {
  kid: string;
  algorithm: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

interface LoadedPublicKey {
  kid: string;
  algorithm: string;
  publicKey: CryptoKey;
}

// ── Global state ────────────────────────────────────────────────
// Keys are stored on globalThis so they survive module
// re-instantiation across Next.js server chunks (turbopack HMR
// and standalone output both create separate module instances).

const g = globalThis as unknown as {
  __jwtCurrentKey?: LoadedKeyPair | null;
  __jwtPreviousKey?: LoadedPublicKey | null;
};

// ── File paths ──────────────────────────────────────────────────

function keysDir(): string {
  return path.join(getDataDir(), "keys");
}

function currentKeyPath(): string {
  return path.join(keysDir(), "jwt-signing.json");
}

function previousKeyPath(): string {
  return path.join(keysDir(), "jwt-signing.prev.json");
}

// ── Key file I/O ────────────────────────────────────────────────

function readKeyFile(filePath: string): JwtKeyFile | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as JwtKeyFile;
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Load JWT signing keys from disk.
 * Current key is required (throws if missing); previous key is optional.
 */
export async function loadSigningKeys(): Promise<void> {
  const currentFile = readKeyFile(currentKeyPath());
  if (!currentFile) {
    throw new Error(
      `JWT signing key not found at ${currentKeyPath()}. Generate one before starting.`,
    );
  }

  g.__jwtCurrentKey = {
    kid: currentFile.kid,
    algorithm: currentFile.algorithm,
    privateKey: (await importJWK(
      currentFile.privateKey,
      currentFile.algorithm,
    )) as CryptoKey,
    publicKey: (await importJWK(
      currentFile.publicKey,
      currentFile.algorithm,
    )) as CryptoKey,
  };

  const prevFile = readKeyFile(previousKeyPath());
  if (prevFile) {
    g.__jwtPreviousKey = {
      kid: prevFile.kid,
      algorithm: prevFile.algorithm,
      publicKey: (await importJWK(
        prevFile.publicKey,
        prevFile.algorithm,
      )) as CryptoKey,
    };
  } else {
    g.__jwtPreviousKey = null;
  }
}

/** Return the current signing key pair. Throws if not loaded. */
export function getSigningKey(): LoadedKeyPair {
  if (!g.__jwtCurrentKey) {
    throw new Error(
      "JWT signing keys not loaded. Call loadSigningKeys() first.",
    );
  }
  return g.__jwtCurrentKey;
}

/** Look up a verification key by `kid`. Returns null if unknown. */
export function getVerificationKey(
  kid: string,
): { publicKey: CryptoKey; algorithm: string } | null {
  if (g.__jwtCurrentKey?.kid === kid) {
    return {
      publicKey: g.__jwtCurrentKey.publicKey,
      algorithm: g.__jwtCurrentKey.algorithm,
    };
  }
  if (g.__jwtPreviousKey?.kid === kid) {
    return {
      publicKey: g.__jwtPreviousKey.publicKey,
      algorithm: g.__jwtPreviousKey.algorithm,
    };
  }
  return null;
}

/**
 * Return raw JWK public key data for all loaded keys.
 * Used to initialize the Edge-compatible stateless verifier.
 */
export function getPublicKeyData(): Array<{
  kid: string;
  algorithm: string;
  publicKey: JWK;
}> {
  const keys: Array<{ kid: string; algorithm: string; publicKey: JWK }> = [];

  const currentFile = readKeyFile(currentKeyPath());
  if (currentFile) {
    keys.push({
      kid: currentFile.kid,
      algorithm: currentFile.algorithm,
      publicKey: currentFile.publicKey,
    });
  }

  const prevFile = readKeyFile(previousKeyPath());
  if (prevFile) {
    keys.push({
      kid: prevFile.kid,
      algorithm: prevFile.algorithm,
      publicKey: prevFile.publicKey,
    });
  }

  return keys;
}

/**
 * Generate a new JWT signing key pair and write it to disk.
 * Defaults to ES256 (ECDSA P-256).
 */
export async function generateJwtSigningKey(
  algorithm = "ES256",
): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, {
    extractable: true,
  });

  const kid = randomUUID();
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  privateJwk.kid = kid;
  publicJwk.kid = kid;

  const keyFile: JwtKeyFile = {
    kid,
    algorithm,
    privateKey: privateJwk,
    publicKey: publicJwk,
  };

  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(currentKeyPath(), JSON.stringify(keyFile, null, 2), "utf8");
}

/** Delete the previous key file and clear it from memory. */
export function removePreviousKey(): void {
  try {
    unlinkSync(previousKeyPath());
  } catch {
    // Already absent — no-op
  }
  g.__jwtPreviousKey = null;
}

/** Reset in-memory state. For testing only. */
export function resetKeyState(): void {
  g.__jwtCurrentKey = null;
  g.__jwtPreviousKey = null;
}
