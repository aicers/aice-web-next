import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export interface TestCerts {
  /** CA certificate PEM (trust root for both sides). */
  caCert: string;
  /** Server certificate PEM, signed by the CA. */
  serverCert: string;
  /** Server private key PEM. */
  serverKey: string;
  /** Client certificate PEM, signed by the CA. */
  clientCert: string;
  /** Client private key PEM. */
  clientKey: string;
  /** Directory the PEMs live in (CA/server/client files + bundle). */
  dir: string;
  /** Paths the mtls module consumes via env vars. */
  paths: { caPath: string; clientCertPath: string; clientKeyPath: string };
}

/**
 * Regenerate if any cert expires within this window. The certs are minted
 * with `-days 1` (~86400s); picking a 1-hour buffer means a rerun that
 * starts within the last hour of validity gets a fresh set, so a long test
 * cannot outlive its own cert.
 */
const EXPIRY_BUFFER_SECONDS = 60 * 60;

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "pipe" });
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, content, "utf8");
}

/**
 * Returns true if `path` exists and the certificate at that path will
 * still be valid `bufferSeconds` from now. `openssl x509 -checkend N`
 * exits 0 when the cert is NOT going to expire within N seconds, and
 * non-zero otherwise (including "already expired").
 */
function isCertFresh(path: string, bufferSeconds: number): boolean {
  if (!existsSync(path)) return false;
  try {
    execFileSync(
      "openssl",
      ["x509", "-checkend", String(bufferSeconds), "-noout", "-in", path],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Generate a short-lived CA plus a server + client cert (both EC P-256,
 * signed by the CA). Subsequent calls with the same `dir` return the
 * already-generated material when all three certs are still within their
 * validity window; if any has expired or will expire within
 * `EXPIRY_BUFFER_SECONDS`, the stale material is wiped and a fresh set is
 * minted. This keeps globalSetup idempotent across normal reruns while
 * protecting long-running developer data directories from silently
 * reusing expired PEMs.
 *
 * The certs are **only** used by the test harness: the mock GraphQL server
 * presents the server cert and requires the client to present a cert signed
 * by the CA, which is exactly the shape the production mTLS code path
 * expects. This lets Playwright E2E scenarios exercise the real mTLS
 * branch in `src/lib/mtls.ts` instead of the env-gated bypass.
 */
export function ensureTestCerts(dir: string): TestCerts {
  const caKey = resolve(dir, "ca-key.pem");
  const caCert = resolve(dir, "ca-cert.pem");
  const serverKey = resolve(dir, "server-key.pem");
  const serverCert = resolve(dir, "server-cert.pem");
  const serverCsr = resolve(dir, "server-csr.pem");
  const serverExt = resolve(dir, "server-ext.cnf");
  const clientKey = resolve(dir, "client-key.pem");
  const clientCert = resolve(dir, "client-cert.pem");
  const clientCsr = resolve(dir, "client-csr.pem");
  const serial = resolve(dir, "ca.srl");

  mkdirSync(dir, { recursive: true });

  // If any cert in the chain is stale or will expire soon, wipe the whole
  // set. Regenerating piecemeal is unsafe — a stale CA would invalidate
  // freshly minted leaves, and a stale server/client cert still belongs to
  // the existing CA, so we keep the regeneration path monolithic.
  const caFresh = isCertFresh(caCert, EXPIRY_BUFFER_SECONDS);
  const serverFresh = isCertFresh(serverCert, EXPIRY_BUFFER_SECONDS);
  const clientFresh = isCertFresh(clientCert, EXPIRY_BUFFER_SECONDS);
  if (!caFresh || !serverFresh || !clientFresh) {
    for (const p of [
      caKey,
      caCert,
      serverKey,
      serverCert,
      serverCsr,
      serverExt,
      clientKey,
      clientCert,
      clientCsr,
      serial,
    ]) {
      removeIfExists(p);
    }
  }

  if (!existsSync(caCert)) {
    run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=aice-test-ca",
    ]);
  }

  if (!existsSync(serverCert)) {
    writeIfMissing(serverExt, "subjectAltName = DNS:localhost, IP:127.0.0.1\n");
    run("openssl", [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      serverKey,
      "-out",
      serverCsr,
      "-nodes",
      "-subj",
      "/CN=localhost",
    ]);
    run("openssl", [
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-CAserial",
      serial,
      "-out",
      serverCert,
      "-days",
      "1",
      "-extfile",
      serverExt,
    ]);
  }

  if (!existsSync(clientCert)) {
    run("openssl", [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      clientKey,
      "-out",
      clientCsr,
      "-nodes",
      "-subj",
      "/CN=aice-web-next",
    ]);
    run("openssl", [
      "x509",
      "-req",
      "-in",
      clientCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAserial",
      serial,
      "-out",
      clientCert,
      "-days",
      "1",
    ]);
  }

  return {
    caCert: readFileSync(caCert, "utf8"),
    serverCert: readFileSync(serverCert, "utf8"),
    serverKey: readFileSync(serverKey, "utf8"),
    clientCert: readFileSync(clientCert, "utf8"),
    clientKey: readFileSync(clientKey, "utf8"),
    dir,
    paths: {
      caPath: caCert,
      clientCertPath: clientCert,
      clientKeyPath: clientKey,
    },
  };
}
