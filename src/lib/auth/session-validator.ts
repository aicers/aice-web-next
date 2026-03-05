import "server-only";

import type { AuditAction } from "@/lib/audit/logger";

import { compareBrowserFingerprints } from "./ua-parser";

// ── Types ───────────────────────────────────────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high";

export interface SessionCheckResult {
  /** Whether the request may proceed. */
  proceed: boolean;
  /** Whether re-authentication is required. */
  requiresReauth: boolean;
  /** Risk level for audit logging. */
  riskLevel: RiskLevel;
  /** Audit actions to record. */
  auditActions: AuditAction[];
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Assess the risk level based on IP and UA changes.
 *
 * Risk matrix (Discussion #32 §8.2):
 *
 * | Change                     | Risk   | Action                     |
 * |----------------------------|--------|----------------------------|
 * | None                       | None   | Proceed                    |
 * | IP only (UA same)          | Low    | Log ip_mismatch, proceed   |
 * | UA minor version change    | Low    | Log ua_mismatch, proceed   |
 * | UA major change (IP same)  | Medium | Log ua_mismatch, re-auth   |
 * | IP + UA both changed       | High   | Log both, re-auth          |
 *
 * If `storedBrowserFingerprint` is empty (legacy session created before
 * the migration), UA comparison is skipped entirely.
 */
export function assessIpUaRisk(params: {
  storedIp: string;
  currentIp: string;
  storedBrowserFingerprint: string;
  currentBrowserFingerprint: string;
}): SessionCheckResult {
  const {
    storedIp,
    currentIp,
    storedBrowserFingerprint,
    currentBrowserFingerprint,
  } = params;

  const ipChanged =
    storedIp !== "unknown" && currentIp !== "unknown" && storedIp !== currentIp;

  // Skip UA comparison for legacy sessions (empty fingerprint)
  const uaChange =
    storedBrowserFingerprint === ""
      ? ("same" as const)
      : compareBrowserFingerprints(
          storedBrowserFingerprint,
          currentBrowserFingerprint,
        );

  const uaMajorChange = uaChange === "major";
  const uaMinorChange = uaChange === "minor";

  // No changes at all
  if (!ipChanged && !uaMajorChange && !uaMinorChange) {
    return {
      proceed: true,
      requiresReauth: false,
      riskLevel: "none",
      auditActions: [],
    };
  }

  // IP + UA both changed → High
  if (ipChanged && uaMajorChange) {
    return {
      proceed: false,
      requiresReauth: true,
      riskLevel: "high",
      auditActions: ["session.ip_mismatch", "session.ua_mismatch"],
    };
  }

  // UA major change only (IP same) → Medium
  if (uaMajorChange) {
    return {
      proceed: false,
      requiresReauth: true,
      riskLevel: "medium",
      auditActions: ["session.ua_mismatch"],
    };
  }

  // IP only changed (UA same) → Low
  if (ipChanged && !uaMinorChange) {
    return {
      proceed: true,
      requiresReauth: false,
      riskLevel: "low",
      auditActions: ["session.ip_mismatch"],
    };
  }

  // UA minor version change → Low
  if (uaMinorChange && !ipChanged) {
    return {
      proceed: true,
      requiresReauth: false,
      riskLevel: "low",
      auditActions: ["session.ua_mismatch"],
    };
  }

  // IP changed + UA minor change → Low (both are low-risk individually)
  return {
    proceed: true,
    requiresReauth: false,
    riskLevel: "low",
    auditActions: ["session.ip_mismatch", "session.ua_mismatch"],
  };
}
