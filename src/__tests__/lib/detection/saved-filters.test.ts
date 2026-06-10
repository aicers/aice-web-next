import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

describe("saved-filters lib", () => {
  let mod: typeof import("@/lib/detection/saved-filters");

  beforeEach(async () => {
    vi.resetModules();
    mockQuery.mockReset();
    mod = await import("@/lib/detection/saved-filters");
  });

  afterEach(() => {
    mockQuery.mockReset();
  });

  describe("validateSavedFilterName", () => {
    it("rejects empty names", () => {
      expect(mod.validateSavedFilterName("")).toBe("empty");
    });

    it("accepts a regular name", () => {
      expect(mod.validateSavedFilterName("Last 1h · High")).toBeNull();
    });

    it("rejects names beyond the cap", () => {
      const tooLong = "x".repeat(mod.SAVED_FILTER_NAME_MAX + 1);
      expect(mod.validateSavedFilterName(tooLong)).toBe("tooLong");
    });
  });

  describe("normalizeSavedFilterName", () => {
    it("trims surrounding whitespace", () => {
      expect(mod.normalizeSavedFilterName("  hello  ")).toBe("hello");
    });
  });

  describe("listSavedFiltersForAccount", () => {
    it("returns rows reassembled into typed Filters", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "Last 1h · High",
            mode: "structured",
            filter_json: { start: "2026-01-01T00:00:00Z", levels: ["HIGH"] },
            created_at: new Date("2026-01-01T00:00:00Z"),
            updated_at: new Date("2026-01-02T00:00:00Z"),
          },
        ],
      });
      const result = await mod.listSavedFiltersForAccount("acct-1");
      expect(result).toEqual([
        {
          id: "11111111-1111-1111-1111-111111111111",
          name: "Last 1h · High",
          filter: {
            mode: "structured",
            input: { start: "2026-01-01T00:00:00Z", levels: ["HIGH"] },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ]);
    });

    it("drops rows with unrecognised modes so a future-mode row never crashes the rail", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 2,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "future-mode-row",
            mode: "experimental-vNext",
            filter_json: { whatever: true },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "22222222-2222-2222-2222-222222222222",
            name: "ok-row",
            mode: "structured",
            filter_json: {},
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const result = await mod.listSavedFiltersForAccount("acct-1");
      expect(result.map((r) => r.name)).toEqual(["ok-row"]);
    });

    it("scopes the SQL to mode = 'structured' so a future query row stays out of the v1 rail", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      await mod.listSavedFiltersForAccount("acct-1");
      const [sql] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain("mode = 'structured'");
    });

    // Reviewer Round 3 — the read path also coerces stored
    // `filter_json` so a row that was persisted before the write-side
    // coerce was wired (or any payload corrupted out-of-band) cannot
    // crash the chip / draft helpers. Bad fields are dropped; the rest
    // of the row still loads.
    it("coerces malformed structured filter_json on read so a bad row does not crash the rail", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "legacy-malformed",
            mode: "structured",
            filter_json: {
              keywords: "not-an-array",
              categories: "not-an-array",
              levels: ["HIGH"],
            },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const result = await mod.listSavedFiltersForAccount("acct-1");
      expect(result).toEqual([
        {
          id: "11111111-1111-1111-1111-111111111111",
          name: "legacy-malformed",
          filter: { mode: "structured", input: { levels: ["HIGH"] } },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
    });

    it("drops non-string `levels` entries on read (a level must be a ThreatLevel string)", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            name: "mixed-numeric-and-enum",
            mode: "structured",
            filter_json: { levels: [1, "HIGH", 999, "VERY_LOW"] },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const result = await mod.listSavedFiltersForAccount("acct-1");
      expect(
        result.map((r) =>
          r.filter.mode === "structured" ? r.filter.input.levels : null,
        ),
      ).toEqual([["HIGH", "VERY_LOW"]]);
    });
  });

  describe("insertSavedFilter", () => {
    it("inserts a structured filter and returns the saved row", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "Last 1h",
            mode: "structured",
            filter_json: { start: "2026-01-01T00:00:00Z" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const saved = await mod.insertSavedFilter({
        accountId: "acct-1",
        name: "Last 1h",
        filter: {
          mode: "structured",
          input: { start: "2026-01-01T00:00:00Z" },
        },
      });
      expect(saved.name).toBe("Last 1h");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual([
        "acct-1",
        "Last 1h",
        "structured",
        JSON.stringify({ start: "2026-01-01T00:00:00Z" }),
      ]);
    });

    it("translates a unique-violation into the typed duplicate error", async () => {
      mockQuery.mockRejectedValue(
        Object.assign(new Error("duplicate key value"), { code: "23505" }),
      );
      await expect(
        mod.insertSavedFilter({
          accountId: "acct-1",
          name: "dup",
          filter: { mode: "structured", input: {} },
        }),
      ).rejects.toBeInstanceOf(mod.SavedFilterDuplicateNameError);
    });

    it("rejects payloads larger than the size cap", async () => {
      // Build a string the JSON serializer will exceed the cap with.
      const huge = "x".repeat(mod.SAVED_FILTER_JSON_MAX_BYTES);
      await expect(
        mod.insertSavedFilter({
          accountId: "acct-1",
          name: "huge",
          filter: { mode: "query", text: huge },
        }),
      ).rejects.toThrow("Saved filter payload exceeds size limit");
    });

    // Reviewer Round 3 — the action layer rejects a non-`structured`
    // mode, but a structured filter whose inner `input` carries a
    // schema-violating field (e.g. `keywords: "not-an-array"`) used to
    // pass straight through `JSON.stringify(filter.input)` and land a
    // crashable row. The runtime coerce inside `storedPayloadFromFilter`
    // now drops the bad field before the row is written.
    it("sanitizes malformed structured fields before insert", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "malformed",
            mode: "structured",
            filter_json: { levels: ["HIGH"] },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await mod.insertSavedFilter({
        accountId: "acct-1",
        name: "malformed",
        // Cast through `unknown` to simulate a crafted client payload
        // whose `EventListFilterInput` shape violates the typed UI's
        // contract — what the runtime coerce has to defend against.
        filter: {
          mode: "structured",
          input: {
            keywords: "not-an-array",
            categories: "not-an-array",
            levels: ["HIGH"],
          },
        } as unknown as import("@/lib/detection").Filter,
      });
      const [, params] = mockQuery.mock.calls[0];
      // The persisted JSON keeps the valid `levels` field and drops
      // every malformed one — never a `keywords: "not-an-array"`.
      expect(params?.[3]).toBe(JSON.stringify({ levels: ["HIGH"] }));
    });

    it("throws SavedFilterInvalidError when the outer filter shape is unrecoverable", async () => {
      await expect(
        mod.insertSavedFilter({
          accountId: "acct-1",
          name: "bad-shape",
          // Direct lib call that bypasses the action's mode guard —
          // exercise the defense-in-depth coerce inside the lib.
          filter: {
            mode: "structured",
            input: null,
          } as unknown as import("@/lib/detection").Filter,
        }),
      ).rejects.toBeInstanceOf(mod.SavedFilterInvalidError);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("renameSavedFilter", () => {
    it("returns the renamed row when the caller owns it", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "renamed",
            mode: "structured",
            filter_json: {},
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
        ],
      });
      const saved = await mod.renameSavedFilter({
        accountId: "acct-1",
        id: "11111111-1111-1111-1111-111111111111",
        newName: "renamed",
      });
      expect(saved.name).toBe("renamed");
    });

    it("throws not-found when the WHERE clause matches no rows (other-owner case)", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(
        mod.renameSavedFilter({
          accountId: "acct-1",
          id: "11111111-1111-1111-1111-111111111111",
          newName: "renamed",
        }),
      ).rejects.toBeInstanceOf(mod.SavedFilterNotFoundError);
    });

    it("translates a unique-violation into the typed duplicate error", async () => {
      mockQuery.mockRejectedValue(
        Object.assign(new Error("dup"), { code: "23505" }),
      );
      await expect(
        mod.renameSavedFilter({
          accountId: "acct-1",
          id: "11111111-1111-1111-1111-111111111111",
          newName: "dup",
        }),
      ).rejects.toBeInstanceOf(mod.SavedFilterDuplicateNameError);
    });
  });

  describe("deleteSavedFilter", () => {
    it("succeeds when the row was deleted", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
      await expect(
        mod.deleteSavedFilter({
          accountId: "acct-1",
          id: "11111111-1111-1111-1111-111111111111",
        }),
      ).resolves.toBeUndefined();
    });

    it("throws not-found when the row didn't belong to the caller", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(
        mod.deleteSavedFilter({
          accountId: "acct-1",
          id: "11111111-1111-1111-1111-111111111111",
        }),
      ).rejects.toBeInstanceOf(mod.SavedFilterNotFoundError);
    });
  });
});
