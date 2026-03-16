import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

describe("dashboard queries", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("getActiveSessions", () => {
    it("returns active sessions with account info", async () => {
      const fakeRows = [
        {
          sid: "s1",
          account_id: "a1",
          username: "admin",
          display_name: "Admin",
          ip_address: "10.0.0.1",
          user_agent: "Chrome/131",
          browser_fingerprint: "Chrome/131",
          created_at: "2026-03-16T00:00:00Z",
          last_active_at: "2026-03-16T01:00:00Z",
          needs_reauth: false,
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: fakeRows, rowCount: 1 });

      const { getActiveSessions } = await import("@/lib/dashboard/queries");
      const result = await getActiveSessions();

      expect(result).toHaveLength(1);
      expect(result[0].sid).toBe("s1");
      expect(result[0].username).toBe("admin");
    });

    it("returns empty array when no active sessions", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getActiveSessions } = await import("@/lib/dashboard/queries");
      const result = await getActiveSessions();

      expect(result).toEqual([]);
    });

    it("queries only non-revoked sessions ordered by last_active_at DESC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getActiveSessions } = await import("@/lib/dashboard/queries");
      await getActiveSessions();

      expect(mockQuery).toHaveBeenCalledOnce();
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("revoked = false");
      expect(sql).toContain("ORDER BY s.last_active_at DESC");
    });
  });

  describe("getLockedSuspendedAccounts", () => {
    it("returns locked and suspended accounts", async () => {
      const fakeRows = [
        {
          id: "a1",
          username: "locked-user",
          display_name: null,
          role_name: "Tenant Administrator",
          status: "locked",
          locked_until: "2026-03-16T02:00:00Z",
          failed_sign_in_count: 5,
          updated_at: "2026-03-16T01:00:00Z",
        },
        {
          id: "a2",
          username: "suspended-user",
          display_name: "Suspended",
          role_name: "Security Monitor",
          status: "suspended",
          locked_until: null,
          failed_sign_in_count: 15,
          updated_at: "2026-03-16T00:30:00Z",
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: fakeRows, rowCount: 2 });

      const { getLockedSuspendedAccounts } = await import(
        "@/lib/dashboard/queries"
      );
      const result = await getLockedSuspendedAccounts();

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe("locked");
      expect(result[1].status).toBe("suspended");
    });

    it("returns empty array when no locked/suspended accounts", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getLockedSuspendedAccounts } = await import(
        "@/lib/dashboard/queries"
      );
      const result = await getLockedSuspendedAccounts();

      expect(result).toEqual([]);
    });

    it("filters by locked and suspended status", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const { getLockedSuspendedAccounts } = await import(
        "@/lib/dashboard/queries"
      );
      await getLockedSuspendedAccounts();

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("locked");
      expect(sql).toContain("suspended");
    });
  });
});
