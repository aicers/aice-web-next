import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAudit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/audit/client", () => ({
  queryAudit: mockQueryAudit,
}));

describe("suspicious activity detection", () => {
  beforeEach(() => {
    mockQueryAudit.mockReset();
  });

  describe("getSuspiciousAlerts", () => {
    it("returns empty array when no suspicious activity", async () => {
      // 6 rules, each returns 0 results
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // brute force
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        }) // lockouts
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        }) // IP/UA mismatch
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        }) // after-hours
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        }) // privilege escalation
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // mass revocations

      const { getSuspiciousAlerts } = await import(
        "@/lib/dashboard/suspicious-activity"
      );
      const alerts = await getSuspiciousAlerts();

      expect(alerts).toEqual([]);
    });

    it("detects brute force attempts", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({
          rows: [
            {
              group_key: "192.168.1.100",
              count: "25",
              latest_at: "2026-03-16T01:00:00Z",
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getSuspiciousAlerts } = await import(
        "@/lib/dashboard/suspicious-activity"
      );
      const alerts = await getSuspiciousAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].rule).toBe("brute_force");
      expect(alerts[0].severity).toBe("critical");
      expect(alerts[0].count).toBe(25);
    });

    it("detects account lockouts", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // brute force
        .mockResolvedValueOnce({
          rows: [{ count: "3", latest_at: "2026-03-16T01:00:00Z" }],
          rowCount: 1,
        }) // lockouts
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getSuspiciousAlerts } = await import(
        "@/lib/dashboard/suspicious-activity"
      );
      const alerts = await getSuspiciousAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].rule).toBe("account_lockout");
      expect(alerts[0].severity).toBe("high");
      expect(alerts[0].count).toBe(3);
    });

    it("sorts by severity (critical first)", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({
          rows: [
            {
              group_key: "10.0.0.1",
              count: "15",
              latest_at: "2026-03-16T01:00:00Z",
            },
          ],
          rowCount: 1,
        }) // brute force (critical)
        .mockResolvedValueOnce({
          rows: [{ count: "2", latest_at: "2026-03-16T00:30:00Z" }],
          rowCount: 1,
        }) // lockouts (high)
        .mockResolvedValueOnce({
          rows: [{ count: "5", latest_at: "2026-03-16T00:45:00Z" }],
          rowCount: 1,
        }) // IP/UA mismatch (medium)
        .mockResolvedValueOnce({
          rows: [{ count: "10", latest_at: "2026-03-16T00:15:00Z" }],
          rowCount: 1,
        }) // after-hours (low)
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getSuspiciousAlerts } = await import(
        "@/lib/dashboard/suspicious-activity"
      );
      const alerts = await getSuspiciousAlerts();

      expect(alerts.length).toBeGreaterThanOrEqual(4);
      expect(alerts[0].severity).toBe("critical");
      expect(alerts[1].severity).toBe("high");
      expect(alerts[2].severity).toBe("medium");
      expect(alerts[3].severity).toBe("low");
    });

    it("aggregates alerts from multiple rules", async () => {
      mockQueryAudit
        .mockResolvedValueOnce({
          rows: [
            {
              group_key: "10.0.0.1",
              count: "12",
              latest_at: "2026-03-16T01:00:00Z",
            },
            {
              group_key: "10.0.0.2",
              count: "11",
              latest_at: "2026-03-16T00:50:00Z",
            },
          ],
          rowCount: 2,
        }) // 2 brute force IPs
        .mockResolvedValueOnce({
          rows: [{ count: "1", latest_at: "2026-03-16T00:30:00Z" }],
          rowCount: 1,
        }) // 1 lockout
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0", latest_at: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getSuspiciousAlerts } = await import(
        "@/lib/dashboard/suspicious-activity"
      );
      const alerts = await getSuspiciousAlerts();

      // 2 brute force + 1 lockout = 3
      expect(alerts).toHaveLength(3);
    });
  });
});
