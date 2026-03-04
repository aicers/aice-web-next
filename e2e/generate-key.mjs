import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
writeFileSync(
  keyPath,
  JSON.stringify(
    { kid, algorithm: "ES256", privateKey: priv, publicKey: pub },
    null,
    2,
  ),
);
console.log(`JWT signing key generated at ${keyPath}`);
