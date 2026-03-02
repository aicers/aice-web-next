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

// ── Module state ────────────────────────────────────────────────

let currentKey: LoadedKeyPair | null = null;
let previousKey: LoadedPublicKey | null = null;

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

  currentKey = {
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
    previousKey = {
      kid: prevFile.kid,
      algorithm: prevFile.algorithm,
      publicKey: (await importJWK(
        prevFile.publicKey,
        prevFile.algorithm,
      )) as CryptoKey,
    };
  } else {
    previousKey = null;
  }
}

/** Return the current signing key pair. Throws if not loaded. */
export function getSigningKey(): LoadedKeyPair {
  if (!currentKey) {
    throw new Error(
      "JWT signing keys not loaded. Call loadSigningKeys() first.",
    );
  }
  return currentKey;
}

/** Look up a verification key by `kid`. Returns null if unknown. */
export function getVerificationKey(
  kid: string,
): { publicKey: CryptoKey; algorithm: string } | null {
  if (currentKey?.kid === kid) {
    return { publicKey: currentKey.publicKey, algorithm: currentKey.algorithm };
  }
  if (previousKey?.kid === kid) {
    return {
      publicKey: previousKey.publicKey,
      algorithm: previousKey.algorithm,
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
  previousKey = null;
}

/** Reset in-memory state. For testing only. */
export function resetKeyState(): void {
  currentKey = null;
  previousKey = null;
}
