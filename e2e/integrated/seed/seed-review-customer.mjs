/**
 * Register a Customer in REview with networks covering the dump's
 * source/destination address space, so REview's `event.origCustomer`
 * resolver returns this customer for matching events.
 *
 * REview verifies the JWT against the public key embedded in the
 * mTLS client certificate presented during the TLS handshake (see
 * review-web `auth/mtls.rs::validate_context_jwt`). The token claims
 * must shape: `{ role: string, customer_ids?: u32[], exp: i64 }`,
 * where `role` is one of REview's role enum string forms (e.g.
 * `"System Administrator"`).
 *
 * Run inside the running aice-web-next container so the mTLS cert
 * paths and DNS for the REview SAN resolve as production:
 *
 *   docker cp e2e/integrated/seed/seed-review-customer.mjs \
 *       aice-web-next-next-app-1:/tmp/seed.mjs
 *   docker exec aice-web-next-next-app-1 node /tmp/seed.mjs
 */

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const CERT_DIR = process.env.MTLS_CERT_DIR ?? "/certs";
const CERT_PATH =
  process.env.MTLS_CERT_PATH ?? `${CERT_DIR}/aice-web-next-cert.pem`;
const KEY_PATH =
  process.env.MTLS_KEY_PATH ?? `${CERT_DIR}/aice-web-next-key.pem`;
const CA_PATH = process.env.MTLS_CA_PATH ?? `${CERT_DIR}/ca-bundle.pem`;
const REVIEW_HOST =
  process.env.REVIEW_HOSTNAME ?? "001.review.review-host.test.local";
const REVIEW_PORT = Number(process.env.REVIEW_PORT ?? 8443);

const privateKey = createPrivateKey({
  key: readFileSync(KEY_PATH),
  format: "pem",
});

function signJwt(payload) {
  const header = { alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, exp: now + 300, iat: now };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("SHA256").update(signingInput).sign({
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(sig)}`;
}

const token = signJwt({ role: "System Administrator" });

const body = JSON.stringify({
  query: `mutation Insert($name: String!, $description: String!, $networks: [CustomerNetworkInput!]!) {
    insertCustomer(name: $name, description: $description, networks: $networks)
  }`,
  variables: {
    name: process.env.SEED_CUSTOMER_NAME ?? "Customer A",
    description: "E2E seeded customer covering the dump address space",
    networks: [
      {
        name: "Default-net",
        description: "Internal + RFC1918",
        networkType: "INTRANET",
        networkGroup: {
          hosts: [],
          networks: ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
          ranges: [],
        },
      },
    ],
  },
});

await new Promise((resolve, reject) => {
  const req = https.request(
    {
      hostname: REVIEW_HOST,
      port: REVIEW_PORT,
      path: "/graphql",
      method: "POST",
      ca: readFileSync(CA_PATH),
      cert: readFileSync(CERT_PATH),
      key: readFileSync(KEY_PATH),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        console.log("status:", res.statusCode);
        console.log("body:", d);
        if (res.statusCode === 200) resolve();
        else reject(new Error(`unexpected status ${res.statusCode}`));
      });
    },
  );
  req.on("error", reject);
  req.write(body);
  req.end();
});
