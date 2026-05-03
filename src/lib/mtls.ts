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

interface LeasedState extends MtlsState {
  refCount: number;
  retired: boolean;
}

let state: LeasedState | null = null;

// Single mutex queue for every write to `state`. ALL paths that assign `state`
// — first-use init AND reload() — run inside this queue. The "single writer"
// property guarantees no two `buildState()` runs install `state` concurrently,
// so a late init can never overwrite a fresher reload result and vice versa.
let stateLifecycle: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = stateLifecycle.then(fn, fn);
  // Swallow this slot's rejection on the chain so a single failure does not
  // poison subsequent enqueues; callers still see the rejection on `next`.
  stateLifecycle = next.catch(() => {});
  return next;
}

let reloadPending: Promise<Agent> | null = null;
let reloadDirty = false;

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

function acquire(s: LeasedState): void {
  s.refCount++;
}

function releaseState(s: LeasedState): void {
  s.refCount--;
  if (s.retired && s.refCount === 0) {
    // Last in-flight request finished; drain the retired agent. Catch the
    // promise so a close() failure cannot become an unhandled rejection
    // (which under --unhandled-rejections=strict would crash the process).
    s.agent.close().catch((err) => {
      // eslint-disable-next-line no-console -- cleanup-path log line
      console.error("[mtls] failed to close retired agent", err);
    });
  }
}

async function ensureState(): Promise<LeasedState> {
  if (state) return state;
  return runExclusive(async () => {
    if (state) return state;
    const built = await buildState();
    state = { ...built, refCount: 1, retired: false };
    return state;
  });
}

/**
 * Read `state` and increment its refcount as one operation, with no
 * microtask boundary in between when state is already installed.
 *
 * The earlier shape `await ensureState(); acquire(current);` had an
 * unleased window: if a concurrent `reload()` had already finished
 * `buildState()` and its continuation was queued behind the awaiter's,
 * the reload could install the new state, retire the old one, and call
 * `releaseState` — driving the old refcount to zero and starting
 * `agent.close()` — before `acquire()` ran. The caller then dispatched
 * with a closing agent. Acquiring synchronously on the fast path (and
 * before returning from the queued first-init job on the slow path)
 * closes that window: the structural refcount is bumped to ≥ 2 before
 * any other microtask can retire the state.
 */
function acquireState(): LeasedState | Promise<LeasedState> {
  if (state) {
    acquire(state);
    return state;
  }
  return runExclusive(async () => {
    if (state) {
      acquire(state);
      return state;
    }
    const built = await buildState();
    state = { ...built, refCount: 1, retired: false };
    acquire(state);
    return state;
  });
}

export async function getAgent(): Promise<Agent> {
  const current = await ensureState();
  return current.agent;
}

export async function signContextJwt(
  role: string,
  customerIds?: number[],
): Promise<string> {
  const current = await ensureState();

  const builder = new SignJWT({
    role,
    ...(customerIds !== undefined && { customer_ids: customerIds }),
  }).setExpirationTime("5m");

  return builder
    .setProtectedHeader({ alg: current.algorithm })
    .sign(current.privateKey);
}

export interface MtlsRequestAuth {
  agent: Agent;
  token: string;
  release(): void;
}

/**
 * Snapshot helper that reads `state` once, increments its refcount, and
 * returns the agent + a freshly-signed JWT derived from that single snapshot.
 *
 * The caller MUST invoke `release()` (typically in a `finally`) so the
 * refcount is decremented when the dispatch completes. `release()` is
 * idempotent: a duplicate call is a no-op rather than pushing the refcount
 * negative — a negative refcount would break the close-deferral timing for
 * the next retired state.
 *
 * Pairing the agent and the JWT against the same `state` reference closes
 * (a) the JWT/cert pairing race during rotation and (b) the
 * "snapshot's agent gets closed mid-request" race.
 */
export async function createMtlsRequestAuth(
  role: string,
  customerIds?: number[],
): Promise<MtlsRequestAuth> {
  const current = await acquireState();
  try {
    const builder = new SignJWT({
      role,
      ...(customerIds !== undefined && { customer_ids: customerIds }),
    }).setExpirationTime("5m");
    const token = await builder
      .setProtectedHeader({ alg: current.algorithm })
      .sign(current.privateKey);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseState(current);
    };
    return { agent: current.agent, token, release };
  } catch (err) {
    releaseState(current);
    throw err;
  }
}

export function reload(): Promise<Agent> {
  if (reloadPending) {
    // Coalesce overlapping reloads. The dirty flag ensures that a SIGHUP
    // arriving mid-reload re-runs buildState() once after the current run,
    // so a fast double rotation always converges on the latest disk state.
    reloadDirty = true;
    return reloadPending;
  }
  reloadPending = runExclusive(async () => {
    try {
      let next: LeasedState;
      do {
        reloadDirty = false;
        const previous = state;
        const built = await buildState();
        next = { ...built, refCount: 1, retired: false };
        state = next;
        if (previous) {
          // Mark retired and drop the structural reference. In-flight
          // requests still hold leases; the last release() will close()
          // the old agent.
          previous.retired = true;
          releaseState(previous);
        }
      } while (reloadDirty);
      return next.agent;
    } finally {
      reloadPending = null;
    }
  });
  return reloadPending;
}
