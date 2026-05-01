import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { exportJWK, generateKeyPair } from "jose";

const dataDir = process.env.DATA_DIR || "data";
const keysDir = resolve(dataDir, "keys");
const keyPath = resolve(keysDir, "jwt-signing.json");

if (existsSync(keyPath)) {
  console.log(`JWT signing key already exists at ${keyPath}`);
  process.exit(0);
}

const { privateKey, publicKey } = await generateKeyPair("ES256", {
  extractable: true,
});

const kid = randomUUID();
const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);
priv.kid = kid;
pub.kid = kid;

mkdirSync(keysDir, { recursive: true });
const tmpPath = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
writeFileSync(
  tmpPath,
  JSON.stringify(
    { kid, algorithm: "ES256", privateKey: priv, publicKey: pub },
    null,
    2,
  ),
);
renameSync(tmpPath, keyPath);
console.log(`JWT signing key generated at ${keyPath}`);
