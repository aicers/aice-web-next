import "server-only";

import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  // Build via array-join so the result is opaque to the Next.js File
  // Tracer: a literal `path.join(getDataDir(), "keys", "jwt-signing.json")`
  // chain gets statically resolved to `<root>/data/keys/jwt-signing.json`
  // and pulls runtime key material into `.next/standalone/`. See #407.
  return [getDataDir(), "keys"].join(path.sep);
}

function defaultKeyBasename(previous: boolean): string {
  // Build the basename via array-join so the literal
  // "jwt-signing[.prev].json" never appears adjacent to `keysDir()` /
  // `path.join` in source. NFT cannot statically resolve
  // `Array.prototype.join`, which keeps it from following
  // readKeyFile() to the on-disk key file at build time. See #407.
  const stem = ["jwt", "signing"].join("-");
  const suffix = previous ? [stem, "prev"].join(".") : stem;
  return [suffix, "json"].join(".");
}

/**
 * Resolve the current key file path.
 *
 * `JWT_SIGNING_KEY_FILE` takes precedence (intended for externally
 * managed key material — Kubernetes Secret mounts, Vault csi driver,
 * etc.).  Otherwise the standard `<DATA_DIR>/keys/jwt-signing.json`
 * location is used.
 */
function currentKeyPath(): string {
  const override = process.env.JWT_SIGNING_KEY_FILE;
  if (override && override.length > 0) return path.resolve(override);
  return [keysDir(), defaultKeyBasename(false)].join(path.sep);
}

/**
 * Resolve the previous key file path.
 *
 * `JWT_SIGNING_KEY_FILE_PREVIOUS` takes precedence.  When only
 * `JWT_SIGNING_KEY_FILE` is set, the previous key continues to load
 * from the standard `<DATA_DIR>/keys/jwt-signing.prev.json` location
 * — this preserves the existing rotation flow and avoids
 * rollout-time session invalidation.
 */
function previousKeyPath(): string {
  const override = process.env.JWT_SIGNING_KEY_FILE_PREVIOUS;
  if (override && override.length > 0) return path.resolve(override);
  return [keysDir(), defaultKeyBasename(true)].join(path.sep);
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
 *
 * Writes the key file with `0600` perms and the parent directory
 * with `0700` perms so the private JWK is not world-readable.
 *
 * Overwrites any existing key at the resolved path — this is the
 * primitive used by the rotation flow.  First-boot autogen and the
 * `gen-jwt-key` ops script must use {@link autoGenerateJwtSigningKeyIfMissing}
 * (or check existence themselves) to avoid invalidating already-issued
 * session tokens.
 */
export async function generateJwtSigningKey(
  algorithm = "ES256",
): Promise<void> {
  const keyPath = currentKeyPath();

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

  // currentKeyPath was resolved at function entry above; reuse it
  // here so JWT_SIGNING_KEY_FILE callers write to the configured
  // location.
  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync only applies the mode to newly created directories;
  // tighten it explicitly so a pre-existing parent is also locked down.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort — some platforms (Windows, certain mounted volumes)
    // do not honor POSIX perms.  The file write below still proceeds.
  }

  const tmpPath = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
  // writeFileSync's `mode` only applies on file creation; force perms
  // afterwards so the umask cannot loosen them.
  writeFileSync(tmpPath, JSON.stringify(keyFile, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // see chmod note above
  }
  renameSync(tmpPath, keyPath);
}

/**
 * Throw if `<DATA_DIR>` is not writable.  Called by the autogen
 * boot path so the operator gets a clear error instead of a cryptic
 * EACCES partway through key generation.
 */
export function assertDataDirWritable(): void {
  const dir = getDataDir();

  // If something already exists at the path, validate it before any
  // mkdir so a stray file (or a wedged mount) produces a clear
  // diagnostic rather than an EEXIST/ENOTDIR deeper in.
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new Error(
      `JWT_SIGNING_KEY_AUTOGEN=1 was requested but DATA_DIR (${dir}) is not a directory.`,
    );
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new Error(
      `JWT_SIGNING_KEY_AUTOGEN=1 was requested but DATA_DIR (${dir}) is not writable. ` +
        "Mount a writable volume at this path or inject the key via JWT_SIGNING_KEY_FILE.",
      { cause },
    );
  }

  try {
    accessSync(dir, fsConstants.W_OK);
  } catch (cause) {
    throw new Error(
      `JWT_SIGNING_KEY_AUTOGEN=1 was requested but DATA_DIR (${dir}) is not writable. ` +
        "Mount a writable volume at this path or inject the key via JWT_SIGNING_KEY_FILE.",
      { cause },
    );
  }
}

/**
 * Idempotent first-boot key generation.
 *
 * Caller is responsible for honoring `JWT_SIGNING_KEY_AUTOGEN=1` and
 * for ensuring no `JWT_SIGNING_KEY_FILE` is set (autogen is for
 * single-instance dev/convenience; multi-replica deployments must
 * inject a shared key via `JWT_SIGNING_KEY_FILE`).
 *
 * Logs a warning once per process so the single-instance constraint
 * is visible in startup logs.
 */
export async function autoGenerateJwtSigningKeyIfMissing(): Promise<void> {
  const keyPath = currentKeyPath();
  if (existsSync(keyPath)) return;

  assertDataDirWritable();

  console.warn(
    "[jwt-keys] JWT_SIGNING_KEY_AUTOGEN=1: generating a new ES256 signing key at " +
      `${keyPath}. This is a single-instance convenience — multi-replica ` +
      "deployments must inject a shared key via JWT_SIGNING_KEY_FILE so every " +
      "replica validates tokens against the same key.",
  );

  await generateJwtSigningKey();
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
