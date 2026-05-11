import { describe, expect, it } from "vitest";

import {
  appendRecentKeyword,
  MAX_KEYWORD_LENGTH,
  MAX_RECENT_KEYWORDS,
  validateKeywordInput,
} from "@/lib/triage/keywords";

describe("validateKeywordInput", () => {
  it("rejects empty string with 'empty'", () => {
    expect(validateKeywordInput("")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects whitespace-only input with 'empty' (trim first)", () => {
    expect(validateKeywordInput("   ")).toEqual({ ok: false, error: "empty" });
    expect(validateKeywordInput("\t\n  ")).toEqual({
      ok: false,
      error: "empty",
    });
  });

  it("rejects input whose trimmed length exceeds MAX_KEYWORD_LENGTH", () => {
    const tooLong = "a".repeat(MAX_KEYWORD_LENGTH + 1);
    expect(validateKeywordInput(tooLong)).toEqual({
      ok: false,
      error: "tooLong",
    });
    // Trim before length check: leading/trailing whitespace must not
    // count toward the cap.
    const padded = `  ${"a".repeat(MAX_KEYWORD_LENGTH)}  `;
    expect(validateKeywordInput(padded)).toEqual({
      ok: true,
      value: "a".repeat(MAX_KEYWORD_LENGTH),
    });
  });

  it("returns the trimmed value when length is at or below MAX_KEYWORD_LENGTH", () => {
    expect(validateKeywordInput("  lateral movement  ")).toEqual({
      ok: true,
      value: "lateral movement",
    });
    expect(validateKeywordInput("a".repeat(MAX_KEYWORD_LENGTH))).toEqual({
      ok: true,
      value: "a".repeat(MAX_KEYWORD_LENGTH),
    });
  });
});

describe("appendRecentKeyword", () => {
  it("prepends a new value and preserves order of existing entries", () => {
    expect(appendRecentKeyword([], "alpha")).toEqual(["alpha"]);
    expect(appendRecentKeyword(["beta", "gamma"], "alpha")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("moves an existing value to the head rather than duplicating it", () => {
    // The duplicate-of-recent rule: re-firing a recent value should
    // move the chip to the most-recent position, not add a second
    // entry.
    expect(appendRecentKeyword(["alpha", "beta", "gamma"], "beta")).toEqual([
      "beta",
      "alpha",
      "gamma",
    ]);
  });

  it("bounds the list at MAX_RECENT_KEYWORDS by evicting the oldest entry", () => {
    const initial = ["a", "b", "c", "d", "e"];
    expect(initial).toHaveLength(MAX_RECENT_KEYWORDS);
    // Submitting a sixth distinct value drops the oldest ("e").
    expect(appendRecentKeyword(initial, "f")).toEqual([
      "f",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("does not exceed MAX_RECENT_KEYWORDS when reordering an existing entry at the tail", () => {
    const initial = ["a", "b", "c", "d", "e"];
    expect(appendRecentKeyword(initial, "e")).toEqual([
      "e",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("does not mutate the input array", () => {
    const initial = ["alpha", "beta"];
    const before = [...initial];
    appendRecentKeyword(initial, "gamma");
    expect(initial).toEqual(before);
  });
});
