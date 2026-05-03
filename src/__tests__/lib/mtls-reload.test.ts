/**
 * End-to-end test for SIGHUP-driven `reload()` behaviour.
 *
 * Spins up an HTTPS+mTLS server (mirroring review's JWT-from-peer-cert
 * verification), rotates the client cert/key on disk, and asserts that
 * `reload()` causes the next outbound request to use the new material —
 * including the snapshot-lease guarantees around in-flight requests.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

import { importSPKI, jwtVerify } from "jose";
import { fetch as undiciFetch } from "undici";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

interface SerialResponse {
  data: { peerSerial: string; jwtRole: string };
  errors?: { message: string }[];
}

describe("mTLS reload + snapshot lease", () => {
  let tmpDir: string;
  let caCertPem: string;
  let serverCertPem: string;
  let serverKeyPem: string;
  let serverPort: number;
  let server: ReturnType<typeof createServer>;
  let certPathA: string;
  let keyPathA: string;
  let certPathB: string;
  let keyPathB: string;
  let serialA: string;
  let serialB: string;

  // The "live" cert/key files the mtls module reads. Tests overwrite these
  // with A or B contents to simulate a rotation on disk.
  let liveCertPath: string;
  let liveKeyPath: string;
  let caPath: string;

  beforeAll(async () => {
    tmpDir = execSync("mktemp -d").toString().trim();

    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${tmpDir}/ca-key.pem -out ${tmpDir}/ca-cert.pem ` +
        `-days 1 -nodes -subj "/CN=test-ca"`,
      { stdio: "pipe" },
    );

    execSync(
      `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${tmpDir}/srv-key.pem -out ${tmpDir}/srv-csr.pem ` +
        `-nodes -subj "/CN=localhost"`,
      { stdio: "pipe" },
    );
    execSync(
      `openssl x509 -req -in ${tmpDir}/srv-csr.pem ` +
        `-CA ${tmpDir}/ca-cert.pem -CAkey ${tmpDir}/ca-key.pem ` +
        `-CAcreateserial -out ${tmpDir}/srv-cert.pem -days 1 ` +
        `-extfile <(echo "subjectAltName=DNS:localhost")`,
      { shell: "/bin/bash", stdio: "pipe" },
    );

    // Two distinct client cert/key pairs, both signed by the same CA.
    for (const tag of ["A", "B"]) {
      execSync(
        `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
          `-keyout ${tmpDir}/client-${tag}-key.pem ` +
          `-out ${tmpDir}/client-${tag}-csr.pem ` +
          `-nodes -subj "/CN=aice-web-next-${tag}"`,
        { stdio: "pipe" },
      );
      execSync(
        `openssl x509 -req -in ${tmpDir}/client-${tag}-csr.pem ` +
          `-CA ${tmpDir}/ca-cert.pem -CAkey ${tmpDir}/ca-key.pem ` +
          `-CAcreateserial -out ${tmpDir}/client-${tag}-cert.pem -days 1`,
        { shell: "/bin/bash", stdio: "pipe" },
      );
    }

    caCertPem = readFileSync(`${tmpDir}/ca-cert.pem`, "utf8");
    serverCertPem = readFileSync(`${tmpDir}/srv-cert.pem`, "utf8");
    serverKeyPem = readFileSync(`${tmpDir}/srv-key.pem`, "utf8");

    certPathA = `${tmpDir}/client-A-cert.pem`;
    keyPathA = `${tmpDir}/client-A-key.pem`;
    certPathB = `${tmpDir}/client-B-cert.pem`;
    keyPathB = `${tmpDir}/client-B-key.pem`;
    caPath = `${tmpDir}/ca-cert.pem`;

    serialA = readSerial(certPathA);
    serialB = readSerial(certPathB);
    expect(serialA).not.toBe(serialB);

    // Path the mtls module is configured to read.
    liveCertPath = `${tmpDir}/live-cert.pem`;
    liveKeyPath = `${tmpDir}/live-key.pem`;

    server = await startServer();
    const addr = server.address();
    serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;

    process.env.MTLS_CERT_PATH = liveCertPath;
    process.env.MTLS_KEY_PATH = liveKeyPath;
    process.env.MTLS_CA_PATH = caPath;
    process.env.REVIEW_GRAPHQL_ENDPOINT = `https://localhost:${serverPort}/graphql`;
  });

  afterAll(async () => {
    delete process.env.MTLS_CERT_PATH;
    delete process.env.MTLS_KEY_PATH;
    delete process.env.MTLS_CA_PATH;
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    execSync(`rm -rf ${tmpDir}`);
  });

  beforeEach(async () => {
    // Reset the mtls module between tests so each test starts with no
    // cached state. The afterEach lease-release in tests is implicit via
    // module reset; tests that retain state must verify their own cleanup.
    vi.resetModules();
    // Start every test with cert A on disk.
    installCert("A");
  });

  function readSerial(certPath: string): string {
    return execSync(`openssl x509 -in ${certPath} -noout -serial`)
      .toString()
      .trim()
      .replace(/^serial=/, "")
      .toLowerCase();
  }

  function installCert(which: "A" | "B") {
    writeFileSync(
      liveCertPath,
      readFileSync(which === "A" ? certPathA : certPathB),
    );
    writeFileSync(
      liveKeyPath,
      readFileSync(which === "A" ? keyPathA : keyPathB),
    );
  }

  function startServer(): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve) => {
      const srv = createServer(
        {
          cert: serverCertPem,
          key: serverKeyPem,
          ca: [caCertPem],
          requestCert: true,
          rejectUnauthorized: true,
        },
        async (req, res) => {
          try {
            const socket = req.socket as import("node:tls").TLSSocket;
            const peerCert = socket.getPeerX509Certificate();
            if (!peerCert) {
              res.writeHead(401);
              res.end(
                JSON.stringify({ errors: [{ message: "no peer cert" }] }),
              );
              return;
            }
            const auth = req.headers.authorization;
            if (!auth?.startsWith("Bearer ")) {
              res.writeHead(401);
              res.end(JSON.stringify({ errors: [{ message: "no bearer" }] }));
              return;
            }
            const pubKeyPem = peerCert.publicKey.export({
              type: "spki",
              format: "pem",
            }) as string;
            const pubKey = await importSPKI(pubKeyPem, "ES256");
            const { payload } = await jwtVerify(auth.slice(7), pubKey);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                data: {
                  peerSerial: peerCert.serialNumber.toLowerCase(),
                  jwtRole: payload.role,
                },
              }),
            );
          } catch (err) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                errors: [
                  { message: err instanceof Error ? err.message : "err" },
                ],
              }),
            );
          }
        },
      );
      srv.listen(0, "localhost", () => resolve(srv));
    });
  }

  async function dispatchWith(
    agent: import("undici").Agent,
    token: string,
  ): Promise<SerialResponse> {
    const res = await undiciFetch(`https://localhost:${serverPort}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: "{ peerSerial jwtRole }" }),
      dispatcher: agent,
    });
    return (await res.json()) as SerialResponse;
  }

  it("after reload, the next request uses the rotated cert", async () => {
    const mtls = await import("@/lib/mtls");

    // Initial request — cert A on disk.
    const auth1 = await mtls.createMtlsRequestAuth("admin");
    const r1 = await dispatchWith(auth1.agent, auth1.token);
    auth1.release();
    expect(r1.data.peerSerial).toBe(serialA);

    // Rotate to cert B on disk and reload.
    installCert("B");
    await mtls.reload();

    const auth2 = await mtls.createMtlsRequestAuth("admin");
    const r2 = await dispatchWith(auth2.agent, auth2.token);
    auth2.release();
    expect(r2.data.peerSerial).toBe(serialB);
  });

  it("snapshot lease pairs JWT with cert and defers close until release", async () => {
    const mtls = await import("@/lib/mtls");

    // Take a lease against cert A.
    const lease = await mtls.createMtlsRequestAuth("admin");
    // Mock close to a no-op resolved promise so the spy observes only the
    // releaseState invocation. (A pass-through call to undici's real
    // Agent.close() can re-invoke `close` internally during pool teardown,
    // which inflates the spy count without indicating a logic bug.)
    const closeSpy = vi
      .spyOn(lease.agent, "close")
      .mockResolvedValue(undefined);

    // Rotate disk to B and reload — A is now retired but still leased.
    installCert("B");
    await mtls.reload();
    expect(closeSpy).not.toHaveBeenCalled();

    // The lease's agent + token still pair: server verifies the JWT against
    // the peer cert's public key, so a JWT-signed-by-A request reaches review
    // over an A TLS session and verifies cleanly. A mixed pair would 401.
    const r = await dispatchWith(lease.agent, lease.token);
    expect(r.data.peerSerial).toBe(serialA);
    expect(r.data.jwtRole).toBe("admin");

    // Releasing the last lease drains the retired agent.
    lease.release();
    // close() is fired synchronously from releaseState; await its promise.
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalledOnce();

    // A duplicate release is a no-op (idempotent).
    lease.release();
    expect(closeSpy).toHaveBeenCalledOnce();

    closeSpy.mockRestore();
  });

  it("concurrent reloads coalesce on the same pending promise", async () => {
    const mtls = await import("@/lib/mtls");
    // Prime the state.
    await mtls.getAgent();

    // Two concurrent reloads should resolve to the same agent (same buildState
    // run installed it). Without coalescing they would each install a separate
    // state and the second would close the first.
    const [a1, a2] = await Promise.all([mtls.reload(), mtls.reload()]);
    expect(a1).toBe(a2);
    expect((a1 as { closed?: boolean }).closed).not.toBe(true);
  });

  it("ensureState serializes concurrent first-use init (single writer)", async () => {
    const mtls = await import("@/lib/mtls");

    const [r1, r2, r3] = await Promise.all([
      mtls.createMtlsRequestAuth("a"),
      mtls.createMtlsRequestAuth("b"),
      mtls.createMtlsRequestAuth("c"),
    ]);
    // All leases share the same underlying agent — proof that ensureState
    // ran buildState exactly once across the three concurrent callers.
    expect(r2.agent).toBe(r1.agent);
    expect(r3.agent).toBe(r1.agent);

    r1.release();
    r2.release();
    r3.release();
  });

  it("releaseState catches agent.close() rejection (no unhandled rejection)", async () => {
    const mtls = await import("@/lib/mtls");
    const lease = await mtls.createMtlsRequestAuth("admin");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(lease.agent, "close").mockRejectedValueOnce(
      new Error("synthetic close failure"),
    );

    // Trigger retirement: install a fresh state via reload(), which marks the
    // current state retired and decrements its structural refcount. With one
    // outstanding lease, the close defers until release().
    installCert("B");
    await mtls.reload();

    lease.release();
    // The retired agent's close() rejects; releaseState must catch it.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(
      "[mtls] failed to close retired agent",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
