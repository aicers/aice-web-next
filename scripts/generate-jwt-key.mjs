#!/usr/bin/env node
/* eslint-disable no-console */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { argv, env, exit } from "node:process";

import { exportJWK, generateKeyPair } from "jose";

// Ops helper for generating an ES256 JWT signing key file outside the
// app boot path.  Mirrors the layout written by
// `src/lib/auth/jwt-keys.ts#generateJwtSigningKey` so an operator can
// pre-seed `<DATA_DIR>/keys/jwt-signing.json` (or a custom location
// pointed to by `JWT_SIGNING_KEY_FILE`) before starting the container.
//
// Refuses to overwrite an existing key by default — overwriting would
// invalidate every issued session token on the next boot.  Pass
// `--force` to opt in to overwrite.

function parseArgs(args) {
  const result = { force: false, output: undefined, algorithm: "ES256" };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--force" || a === "-f") {
      result.force = true;
    } else if (a === "--output" || a === "-o") {
      result.output = args[i + 1];
      i += 1;
    } else if (a.startsWith("--output=")) {
      result.output = a.slice("--output=".length);
    } else if (a === "--algorithm") {
      result.algorithm = args[i + 1];
      i += 1;
    } else if (a.startsWith("--algorithm=")) {
      result.algorithm = a.slice("--algorithm=".length);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      exit(2);
    }
  }
  return result;
}

function printHelp() {
  console.log(
    `Usage: pnpm gen-jwt-key [--output <path>] [--force] [--algorithm <alg>]

Generate an ES256 JWT signing key and write it to disk.

Resolution order for the output path:
  1. --output / -o flag
  2. JWT_SIGNING_KEY_FILE env var
  3. \${DATA_DIR:-./data}/keys/jwt-signing.json

By default refuses to overwrite an existing file. Use --force to
overwrite (this invalidates every already-issued session token on the
next boot).`,
  );
}

function resolveOutputPath(cli) {
  if (cli.output) return path.resolve(cli.output);
  if (env.JWT_SIGNING_KEY_FILE && env.JWT_SIGNING_KEY_FILE.length > 0) {
    return path.resolve(env.JWT_SIGNING_KEY_FILE);
  }
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : path.resolve(process.cwd(), "data");
  return path.join(dataDir, "keys", "jwt-signing.json");
}

async function main() {
  const cli = parseArgs(argv.slice(2));
  const keyPath = resolveOutputPath(cli);

  if (existsSync(keyPath) && !cli.force) {
    console.error(
      `Refusing to overwrite existing key at ${keyPath}. ` +
        "Pass --force if this is intentional (overwriting invalidates every issued session token on the next boot).",
    );
    exit(1);
  }

  const { privateKey, publicKey } = await generateKeyPair(cli.algorithm, {
    extractable: true,
  });
  const kid = randomUUID();
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  privateJwk.kid = kid;
  publicJwk.kid = kid;

  const keyFile = {
    kid,
    algorithm: cli.algorithm,
    privateKey: privateJwk,
    publicKey: publicJwk,
  };

  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that don't honor POSIX perms
  }

  const tmpPath = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(keyFile, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmpPath, keyPath);

  console.log(`Wrote ${cli.algorithm} signing key to ${keyPath} (kid=${kid})`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
