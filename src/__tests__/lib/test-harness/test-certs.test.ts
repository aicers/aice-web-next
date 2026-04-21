import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureTestCerts } from "@/test-harness/test-certs";

const EXPIRED_CA_FIXTURE = resolve(
  __dirname,
  "../../fixtures/test-harness/expired-ca-cert.pem",
);

function notAfterEpoch(path: string): number {
  const out = execFileSync("openssl", [
    "x509",
    "-enddate",
    "-noout",
    "-in",
    path,
  ]).toString();
  const match = /notAfter=(.+)/.exec(out);
  if (!match) throw new Error(`could not parse notAfter from: ${out}`);
  const parsed = Date.parse(match[1]);
  if (Number.isNaN(parsed)) {
    throw new Error(`could not parse notAfter date: ${match[1]}`);
  }
  return parsed;
}

describe("ensureTestCerts", () => {
  it("reuses existing PEMs when they are still fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-certs-fresh-"));
    try {
      const first = ensureTestCerts(dir);
      const second = ensureTestCerts(dir);
      expect(second.caCert).toBe(first.caCert);
      expect(second.serverCert).toBe(first.serverCert);
      expect(second.clientCert).toBe(first.clientCert);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerates the chain when the CA cert is past its validity window", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-certs-stale-"));
    try {
      const caCert = resolve(dir, "ca-cert.pem");
      const serverCert = resolve(dir, "server-cert.pem");
      const clientCert = resolve(dir, "client-cert.pem");

      const first = ensureTestCerts(dir);
      const firstCaBody = readFileSync(caCert, "utf8");

      // Swap in a long-expired stub CA cert so `openssl x509 -checkend`
      // fails. The harness should wipe all three PEMs and mint a fresh
      // set rather than continuing to serve the expired material. The
      // PEM ships as a fixture because the OpenSSL flags that mint a
      // back-dated cert (`-not_before` / `-not_after`) are only
      // available in OpenSSL >= 3.2; Ubuntu CI runners still ship
      // 3.0.x.
      writeFileSync(caCert, readFileSync(EXPIRED_CA_FIXTURE, "utf8"), "utf8");

      expect(existsSync(serverCert)).toBe(true);
      expect(existsSync(clientCert)).toBe(true);

      const second = ensureTestCerts(dir);

      expect(second.caCert).not.toBe(firstCaBody);
      // New CA must still be within its validity window — i.e. not the
      // expired stub we swapped in.
      expect(notAfterEpoch(caCert)).toBeGreaterThan(Date.now());
      // Server and client leaves must be re-issued under the new CA, not
      // left behind signed by the old one.
      expect(second.serverCert).not.toBe(first.serverCert);
      expect(second.clientCert).not.toBe(first.clientCert);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerates when the CA cert is missing even if leaves still exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-certs-missing-ca-"));
    try {
      const caCert = resolve(dir, "ca-cert.pem");
      const serverCert = resolve(dir, "server-cert.pem");

      const first = ensureTestCerts(dir);
      rmSync(caCert);
      // Touch the server cert to confirm existsSync alone was not the
      // old gating signal. ensureTestCerts should still refresh.
      utimesSync(serverCert, new Date(), new Date());

      const second = ensureTestCerts(dir);
      expect(existsSync(caCert)).toBe(true);
      expect(second.serverCert).not.toBe(first.serverCert);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
