import "server-only";

import { queryAudit } from "@/lib/audit/client";

// ── Types ────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export interface SuspiciousAlert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  count: number;
  latest_at: string;
  details: Record<string, unknown>;
}

interface CountRow {
  count: string;
  latest_at: string;
}

interface GroupedRow {
  group_key: string;
  count: string;
  latest_at: string;
}

// ── Detection window ─────────────────────────────────────────────

const WINDOW_HOURS = 24;

// ── Detection rules ──────────────────────────────────────────────

/**
 * Rule 1: Brute-force attempts — multiple sign-in failures from same IP.
 */
async function detectBruteForce(): Promise<SuspiciousAlert[]> {
  const threshold = 10;
  const { rows } = await queryAudit<GroupedRow>(
    `SELECT ip_address AS group_key, COUNT(*) AS count,
            MAX(timestamp) AS latest_at
       FROM audit_logs
      WHERE action = 'auth.sign_in.failure'
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND ip_address IS NOT NULL
      GROUP BY ip_address
     HAVING COUNT(*) >= $1
      ORDER BY count DESC
      LIMIT 20`,
    [threshold],
  );

  return rows.map((r, i) => ({
    id: `brute-force-${i}`,
    rule: "brute_force",
    severity: "critical" as const,
    count: Number.parseInt(r.count, 10),
    latest_at: r.latest_at,
    details: { ip: r.group_key },
  }));
}

/**
 * Rule 2: Account lockouts in the detection window.
 */
async function detectAccountLockouts(): Promise<SuspiciousAlert[]> {
  const { rows } = await queryAudit<CountRow>(
    `SELECT COUNT(*) AS count, MAX(timestamp) AS latest_at
       FROM audit_logs
      WHERE action = 'account.lock'
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'`,
  );

  const count = Number.parseInt(rows[0].count, 10);
  if (count === 0) return [];

  return [
    {
      id: "account-lockouts",
      rule: "account_lockout",
      severity: "high",

      count,
      latest_at: rows[0].latest_at,
      details: {},
    },
  ];
}

/**
 * Rule 3: Session IP or UA mismatch events.
 */
async function detectIpUaMismatches(): Promise<SuspiciousAlert[]> {
  const { rows } = await queryAudit<CountRow>(
    `SELECT COUNT(*) AS count, MAX(timestamp) AS latest_at
      FROM audit_logs
      WHERE action IN (
              'session.ip_mismatch',
              'session.ua_mismatch'
            )
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'`,
  );

  const count = Number.parseInt(rows[0].count, 10);
  if (count === 0) return [];

  return [
    {
      id: "ip-ua-mismatch",
      rule: "ip_ua_mismatch",
      severity: "medium",

      count,
      latest_at: rows[0].latest_at,
      details: {},
    },
  ];
}

/**
 * Rule 4: After-hours sign-ins (22:00–06:00 UTC).
 */
async function detectAfterHoursSignIns(): Promise<SuspiciousAlert[]> {
  const { rows } = await queryAudit<CountRow>(
    `SELECT COUNT(*) AS count, MAX(timestamp) AS latest_at
       FROM audit_logs
      WHERE action = 'auth.sign_in.success'
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND (EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') >= 22
             OR EXTRACT(HOUR FROM timestamp AT TIME ZONE 'UTC') < 6)`,
  );

  const count = Number.parseInt(rows[0].count, 10);
  if (count === 0) return [];

  return [
    {
      id: "after-hours",
      rule: "after_hours",
      severity: "low",

      count,
      latest_at: rows[0].latest_at,
      details: {},
    },
  ];
}

/**
 * Rule 5: Privilege escalation — role changes to System Administrator.
 */
async function detectPrivilegeEscalation(): Promise<SuspiciousAlert[]> {
  const { rows } = await queryAudit<CountRow>(
    `SELECT COUNT(*) AS count, MAX(timestamp) AS latest_at
       FROM audit_logs
      WHERE action = 'account.update'
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND details::text LIKE '%System Administrator%'`,
  );

  const count = Number.parseInt(rows[0].count, 10);
  if (count === 0) return [];

  return [
    {
      id: "privilege-escalation",
      rule: "privilege_escalation",
      severity: "high",

      count,
      latest_at: rows[0].latest_at,
      details: {},
    },
  ];
}

/**
 * Rule 6: Mass session revocations from same actor (threshold: 5+).
 */
async function detectMassRevocations(): Promise<SuspiciousAlert[]> {
  const threshold = 5;
  const { rows } = await queryAudit<GroupedRow>(
    `SELECT actor_id AS group_key, COUNT(*) AS count,
            MAX(timestamp) AS latest_at
       FROM audit_logs
      WHERE action = 'session.revoke'
        AND timestamp >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
      GROUP BY actor_id
     HAVING COUNT(*) >= $1
      ORDER BY count DESC
      LIMIT 10`,
    [threshold],
  );

  return rows.map((r, i) => ({
    id: `mass-revocation-${i}`,
    rule: "mass_revocation",
    severity: "medium" as const,
    count: Number.parseInt(r.count, 10),
    latest_at: r.latest_at,
    details: { actor: r.group_key },
  }));
}

// ── Severity ordering ────────────────────────────────────────────

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Public API ───────────────────────────────────────────────────

/**
 * Run all 6 detection rules and return combined alerts sorted by
 * severity (critical first).
 */
export async function getSuspiciousAlerts(): Promise<SuspiciousAlert[]> {
  const results = await Promise.all([
    detectBruteForce(),
    detectAccountLockouts(),
    detectIpUaMismatches(),
    detectAfterHoursSignIns(),
    detectPrivilegeEscalation(),
    detectMassRevocations(),
  ]);

  return results
    .flat()
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
