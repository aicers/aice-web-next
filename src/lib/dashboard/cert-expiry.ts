import "server-only";

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Types ────────────────────────────────────────────────────────

export type CertSeverity = "ok" | "warning" | "critical";

export interface CertStatus {
  configured: boolean;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  severity?: CertSeverity;
}

// ── Thresholds ───────────────────────────────────────────────────

const WARNING_DAYS = 30;
const CRITICAL_DAYS = 7;

// ── Public API ───────────────────────────────────────────────────

/**
 * Read the mTLS certificate from MTLS_CERT_PATH, parse its expiry
 * date, and return a severity-tagged status object.
 *
 * Returns `{ configured: false }` when MTLS_CERT_PATH is not set
 * or the file cannot be read (graceful degradation — not every
 * deployment uses mTLS).
 */
export function getCertStatus(): CertStatus {
  const certPath = process.env.MTLS_CERT_PATH;
  if (!certPath) {
    return { configured: false };
  }

  let pem: string;
  try {
    pem = readFileSync(certPath, "utf8");
  } catch {
    return { configured: false };
  }

  const cert = new X509Certificate(pem);
  const validTo = new Date(cert.validTo);
  const now = new Date();
  const msRemaining = validTo.getTime() - now.getTime();
  const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));

  let severity: CertSeverity;
  if (daysRemaining < CRITICAL_DAYS) {
    severity = "critical";
  } else if (daysRemaining < WARNING_DAYS) {
    severity = "warning";
  } else {
    severity = "ok";
  }

  return {
    configured: true,
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysRemaining,
    severity,
  };
}
