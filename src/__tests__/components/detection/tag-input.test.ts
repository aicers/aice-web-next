import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useState: (v: unknown) => [v, vi.fn()],
}));

type TagInputModule = typeof import("@/components/detection/tag-input");

describe("tag-input helpers", () => {
  let normalizeTags: TagInputModule["normalizeTags"];
  let tagKeyAction: TagInputModule["tagKeyAction"];
  let splitTagTokens: TagInputModule["splitTagTokens"];
  let mergeDraftWithPaste: TagInputModule["mergeDraftWithPaste"];

  it("loads module", async () => {
    const mod = await import("@/components/detection/tag-input");
    normalizeTags = mod.normalizeTags;
    tagKeyAction = mod.tagKeyAction;
    splitTagTokens = mod.splitTagTokens;
    mergeDraftWithPaste = mod.mergeDraftWithPaste;
  });

  it("trims entries", () => {
    expect(normalizeTags(["  alpha  ", "beta"])).toEqual(["alpha", "beta"]);
  });

  it("drops empties and whitespace-only entries", () => {
    expect(normalizeTags(["", "  ", "alpha"])).toEqual(["alpha"]);
  });

  it("dedupes preserving first-seen order", () => {
    expect(normalizeTags(["alpha", "beta", "alpha", " beta "])).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeTags([])).toEqual([]);
  });

  describe("mergeDraftWithPaste + splitTagTokens", () => {
    // Regression: draft "alpha" + paste "beta,gamma" used to concatenate
    // the first pasted token onto the draft, yielding ["alphabeta",
    // "gamma"] instead of three distinct tags. The merge now injects a
    // delimiter so splitTagTokens produces a clean three-token list.
    it("keeps the uncommitted draft separate from the first pasted token", () => {
      const merged = mergeDraftWithPaste("alpha", "beta,gamma");
      expect(splitTagTokens(merged)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("handles newline-separated paste with an existing draft", () => {
      const merged = mergeDraftWithPaste("alpha", "beta\ngamma");
      expect(splitTagTokens(merged)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("drops the leading empty segment when the draft is empty", () => {
      const merged = mergeDraftWithPaste("", "beta,gamma");
      expect(splitTagTokens(merged)).toEqual(["beta", "gamma"]);
    });

    it("trims whitespace around merged tokens", () => {
      const merged = mergeDraftWithPaste("  alpha  ", "  beta  , gamma ");
      expect(splitTagTokens(merged)).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  describe("tagKeyAction", () => {
    it("commits on Enter with a non-empty draft", () => {
      expect(tagKeyAction("Enter", "alpha", 0, { isComposing: false })).toEqual(
        { kind: "commit", preventDefault: true },
      );
    });

    it("commits on comma with a non-empty draft", () => {
      expect(tagKeyAction(",", "alpha", 0, { isComposing: false })).toEqual({
        kind: "commit",
        preventDefault: true,
      });
    });

    it("leaves Enter on empty draft untouched so the form can submit", () => {
      expect(tagKeyAction("Enter", "", 0, { isComposing: false })).toEqual({
        kind: "noop",
        preventDefault: false,
      });
    });

    it("swallows a bare comma so it can't leak into the draft", () => {
      expect(tagKeyAction(",", "", 0, { isComposing: false })).toEqual({
        kind: "noop",
        preventDefault: true,
      });
    });

    it("removes the last tag on Backspace when the draft is empty", () => {
      expect(tagKeyAction("Backspace", "", 2, { isComposing: false })).toEqual({
        kind: "removeLast",
        preventDefault: true,
      });
    });

    it("ignores Backspace when the draft still has characters", () => {
      expect(tagKeyAction("Backspace", "a", 2, { isComposing: false })).toEqual(
        { kind: "noop", preventDefault: false },
      );
    });

    it("ignores Backspace when there are no tags to remove", () => {
      expect(tagKeyAction("Backspace", "", 0, { isComposing: false })).toEqual({
        kind: "noop",
        preventDefault: false,
      });
    });

    // Regression: Korean / Japanese / Chinese IMEs press Enter to
    // confirm a composition. Committing (or preventing default) on
    // that keystroke eats the composition and prevents the character
    // from reaching the draft at all.
    it("ignores Enter while an IME composition is active", () => {
      expect(tagKeyAction("Enter", "한글", 0, { isComposing: true })).toEqual({
        kind: "noop",
        preventDefault: false,
      });
    });

    it("ignores comma while an IME composition is active", () => {
      expect(tagKeyAction(",", "kana", 0, { isComposing: true })).toEqual({
        kind: "noop",
        preventDefault: false,
      });
    });

    it("ignores Backspace while an IME composition is active", () => {
      // Backspace during composition walks back through candidate
      // characters; the input must not hijack it to drop a tag.
      expect(tagKeyAction("Backspace", "", 1, { isComposing: true })).toEqual({
        kind: "noop",
        preventDefault: false,
      });
    });
  });
});
