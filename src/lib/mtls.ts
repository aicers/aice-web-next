import "server-only";

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { generateKeyPair, importPKCS8, SignJWT } from "jose";
import { Agent } from "undici";

type JwtAlgorithm = "RS256" | "RS384" | "RS512" | "ES256" | "ES384";

interface MtlsState {
  agent: Agent;
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  algorithm: JwtAlgorithm;
}

let state: MtlsState | null = null;

/**
 * Test-only bypass: when running under the test harness, return a plain-HTTP
 * dispatcher and an ephemeral ES256 signing key so requests can be routed to
 * a non-mTLS mock GraphQL server. Gated by both `NODE_ENV === 'test'` and
 * `TEST_ALLOW_PLAIN_GRAPHQL=1` to make accidental enabling in dev / prod
 * impossible. A loud warning is printed at first use.
 *
 * The mTLS code path is still exercised by `src/__tests__/lib/mtls-e2e.test.ts`,
 * which spins up a real HTTPS + mTLS server.
 */
function isPlainGraphqlBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.TEST_ALLOW_PLAIN_GRAPHQL === "1"
  );
}

let bypassWarned = false;
function warnBypassOnce(): void {
  if (bypassWarned) return;
  bypassWarned = true;
  // eslint-disable-next-line no-console -- intentional, see docstring
  console.warn(
    "============================================================\n" +
      "  WARNING: mTLS bypass is ACTIVE.\n" +
      "  REVIEW_GRAPHQL_ENDPOINT will be reached over plain HTTP\n" +
      "  with an ephemeral JWT signing key. This branch is allowed\n" +
      "  ONLY when NODE_ENV=test AND TEST_ALLOW_PLAIN_GRAPHQL=1.\n" +
      "  If you see this in production, abort immediately.\n" +
      "============================================================",
  );
}

async function buildBypassState(): Promise<MtlsState> {
  warnBypassOnce();
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    // A bare undici Agent with no `connect.cert/key/ca` performs plain
    // HTTP/HTTPS without client-cert auth, which is what the mock server
    // expects.
    agent: new Agent(),
    privateKey,
    algorithm: "ES256",
  };
}

export function detectAlgorithm(certPem: string): JwtAlgorithm {
  const x509 = new X509Certificate(certPem);
  const { asymmetricKeyType, asymmetricKeyDetails } = x509.publicKey;

  if (asymmetricKeyType === "rsa") {
    const bits = asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits >= 4096) return "RS512";
    if (bits >= 3072) return "RS384";
    return "RS256";
  }
  if (asymmetricKeyType === "ec") {
    const curve = asymmetricKeyDetails?.namedCurve;
    if (curve === "prime256v1") return "ES256";
    if (curve === "secp384r1") return "ES384";
    throw new Error(`Unsupported EC curve: ${curve}`);
  }
  throw new Error(`Unsupported key type: ${asymmetricKeyType}`);
}

function readEnvPath(envVar: string): string {
  const filePath = process.env[envVar];
  if (!filePath) {
    throw new Error(`Missing environment variable: ${envVar}`);
  }
  return readFileSync(filePath, "utf8");
}

async function buildState(): Promise<MtlsState> {
  if (isPlainGraphqlBypassEnabled()) return buildBypassState();

  const cert = readEnvPath("MTLS_CERT_PATH");
  const key = readEnvPath("MTLS_KEY_PATH");
  const ca = readEnvPath("MTLS_CA_PATH");

  const algorithm = detectAlgorithm(cert);
  const privateKey = await importPKCS8(key, algorithm);

  const agent = new Agent({
    connect: { cert, key, ca },
  });

  return { agent, privateKey, algorithm };
}

async function initialize(): Promise<MtlsState> {
  state = await buildState();
  return state;
}

export async function getAgent(): Promise<Agent> {
  const current = state ?? (await initialize());
  return current.agent;
}

export async function signContextJwt(
  role: string,
  customerIds?: number[],
): Promise<string> {
  const current = state ?? (await initialize());

  const builder = new SignJWT({
    role,
    ...(customerIds !== undefined && { customer_ids: customerIds }),
  }).setExpirationTime("5m");

  return builder
    .setProtectedHeader({ alg: current.algorithm })
    .sign(current.privateKey);
}

export async function reload(): Promise<Agent> {
  const previous = state;
  state = await buildState();
  if (previous) {
    await previous.agent.close();
  }
  return state.agent;
}
