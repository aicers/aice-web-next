import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SavedFilterDuplicateNameError,
  SavedFilterNotFoundError,
} from "@/lib/detection/saved-filters";

const {
  mockGetCurrentSession,
  mockListSavedFiltersForAccount,
  mockInsertSavedFilter,
  mockRenameSavedFilter,
  mockDeleteSavedFilter,
} = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
  mockListSavedFiltersForAccount: vi.fn(),
  mockInsertSavedFilter: vi.fn(),
  mockRenameSavedFilter: vi.fn(),
  mockDeleteSavedFilter: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

// Partial mock — keep the real error classes, validators, and the
// constants exported from the module, but stub out the DB-touching
// helpers so the action tests stay hermetic.
vi.mock("@/lib/detection/saved-filters", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/detection/saved-filters")
  >("@/lib/detection/saved-filters");
  return {
    ...actual,
    listSavedFiltersForAccount: mockListSavedFiltersForAccount,
    insertSavedFilter: mockInsertSavedFilter,
    renameSavedFilter: mockRenameSavedFilter,
    deleteSavedFilter: mockDeleteSavedFilter,
  };
});

const SAVED = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Last 1h",
  filter: { mode: "structured" as const, input: {} },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("saved-filter server actions", () => {
  let actions: typeof import("@/app/[locale]/(dashboard)/detection/saved-filter-actions");

  beforeEach(async () => {
    mockGetCurrentSession.mockReset();
    mockListSavedFiltersForAccount.mockReset();
    mockInsertSavedFilter.mockReset();
    mockRenameSavedFilter.mockReset();
    mockDeleteSavedFilter.mockReset();
    actions = await import(
      "@/app/[locale]/(dashboard)/detection/saved-filter-actions"
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("listSavedFilters", () => {
    it("returns unauthenticated when no session", async () => {
      mockGetCurrentSession.mockResolvedValue(null);
      const result = await actions.listSavedFilters();
      expect(result).toEqual({ ok: false, code: "unauthenticated" });
    });

    it("scopes the query to the caller's account id", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockListSavedFiltersForAccount.mockResolvedValue([SAVED]);
      const result = await actions.listSavedFilters();
      expect(result).toEqual({ ok: true, filters: [SAVED] });
      expect(mockListSavedFiltersForAccount).toHaveBeenCalledWith("acct-1");
    });

    it("translates a thrown DB error into server-error", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockListSavedFiltersForAccount.mockRejectedValue(new Error("boom"));
      const result = await actions.listSavedFilters();
      expect(result).toEqual({ ok: false, code: "server-error" });
    });
  });

  describe("saveFilter", () => {
    it("rejects empty names with invalid-name", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      const result = await actions.saveFilter("   ", {
        mode: "structured",
        input: {},
      });
      expect(result).toEqual({ ok: false, code: "invalid-name" });
      expect(mockInsertSavedFilter).not.toHaveBeenCalled();
    });

    it("translates a duplicate-name error into the typed code", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockInsertSavedFilter.mockRejectedValue(
        new SavedFilterDuplicateNameError("Last 1h"),
      );
      const result = await actions.saveFilter("Last 1h", {
        mode: "structured",
        input: {},
      });
      expect(result).toEqual({ ok: false, code: "duplicate-name" });
    });

    it("returns the saved filter on success and trims the name", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockInsertSavedFilter.mockResolvedValue(SAVED);
      const result = await actions.saveFilter("  Last 1h  ", SAVED.filter);
      expect(result).toEqual({ ok: true, filter: SAVED });
      expect(mockInsertSavedFilter).toHaveBeenCalledWith({
        accountId: "acct-1",
        name: "Last 1h",
        filter: SAVED.filter,
      });
    });
  });

  describe("renameFilter", () => {
    it("translates not-found into the typed code", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockRenameSavedFilter.mockRejectedValue(new SavedFilterNotFoundError());
      const result = await actions.renameFilter(SAVED.id, "rename");
      expect(result).toEqual({ ok: false, code: "not-found" });
    });
  });

  describe("deleteFilter", () => {
    it("translates not-found into the typed code", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockDeleteSavedFilter.mockRejectedValue(new SavedFilterNotFoundError());
      const result = await actions.deleteFilter(SAVED.id);
      expect(result).toEqual({ ok: false, code: "not-found" });
    });

    it("succeeds when the row is deleted", async () => {
      mockGetCurrentSession.mockResolvedValue({ accountId: "acct-1" });
      mockDeleteSavedFilter.mockResolvedValue(undefined);
      const result = await actions.deleteFilter(SAVED.id);
      expect(result).toEqual({ ok: true });
      expect(mockDeleteSavedFilter).toHaveBeenCalledWith({
        accountId: "acct-1",
        id: SAVED.id,
      });
    });
  });
});
