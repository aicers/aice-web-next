import { describe, expect, it } from "vitest";

import {
  buildCspHeaderValue,
  CSP_HEADER_NAME,
  CSP_REQUEST_HEADER,
  generateCspNonce,
  NONCE_HEADER,
} from "@/lib/security/csp";

describe("csp", () => {
  describe("generateCspNonce()", () => {
    it("returns a non-empty base64 string", () => {
      const nonce = generateCspNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(nonce.length).toBeGreaterThan(0);
    });

    it("produces a distinct nonce per call (collision-resistant)", () => {
      const a = generateCspNonce();
      const b = generateCspNonce();
      expect(a).not.toBe(b);
    });
  });

  describe("buildCspHeaderValue()", () => {
    it("includes the per-request nonce in script-src with strict-dynamic", () => {
      const csp = buildCspHeaderValue("test-nonce");
      expect(csp).toContain(
        "script-src 'self' 'nonce-test-nonce' 'strict-dynamic'",
      );
    });

    it("locks down frame-ancestors to none", () => {
      const csp = buildCspHeaderValue("n");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("keeps style-src 'unsafe-inline' (Next styled-jsx compatibility)", () => {
      // Documented constraint — promotion to nonce-based style-src is
      // a follow-up issue.  The Report-Only roll-out must not break
      // existing inline styles.
      const csp = buildCspHeaderValue("n");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    });

    it("includes default-src 'self', object-src 'none', base-uri 'self'", () => {
      const csp = buildCspHeaderValue("n");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });
  });

  describe("constants", () => {
    it("CSP_HEADER_NAME is Content-Security-Policy-Report-Only (not enforcing)", () => {
      // Issue #404 part O — first release ships in Report-Only.
      expect(CSP_HEADER_NAME).toBe("Content-Security-Policy-Report-Only");
    });

    it("NONCE_HEADER is the conventional x-nonce", () => {
      expect(NONCE_HEADER).toBe("x-nonce");
    });

    it("CSP_REQUEST_HEADER is the unprefixed Content-Security-Policy", () => {
      // Next's renderer parses this *request* header for the nonce; it
      // must be the enforcing-style name even when the response ships
      // CSP in Report-Only mode.
      expect(CSP_REQUEST_HEADER).toBe("Content-Security-Policy");
    });
  });
});
