import { describe, expect, it } from "vitest";

import {
  applyConfidenceMin,
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  type DetectionFilterDraft,
  formatConfidenceInput,
  setConfidenceMin,
} from "@/lib/detection/filter-draft";

/**
 * Mirror of the two pieces of state that back a single confidence
 * input inside `FilterDrawer`: the transient `text` (displayed as the
 * input's `value` while typing) and the `draft` (committed on every
 * keystroke so the min/max invariant and the outgoing submission stay
 * in sync).
 *
 * The transitions below are the same ones the component wires up in
 * `onConfidenceMinChange` / `onConfidenceMinBlur` / the Home/End
 * `onKeyDown` branches. A previous revision bound the input's `value`
 * directly to `formatConfidenceInput(draft.confidenceMin)` — every
 * keystroke was reformatted to two decimals, so typing `0.70`
 * character-by-character was impossible. This test exists to lock in
 * the split.
 */
interface MinInputHarness {
  text: string;
  draft: DetectionFilterDraft;
}

describe("filter-drawer confidence input interaction", () => {
  function base(): DetectionFilterDraft {
    return {
      period: null,
      startLocal: "",
      endLocal: "",
      startIso: null,
      endIso: null,
      directions: ["OUTBOUND", "INTERNAL", "INBOUND"],
      endpoints: [],
      confidenceMin: 0,
      confidenceMax: 1,
      sensorIds: [],
      levels: [],
      countries: [],
      learningMethods: [],
      categories: [],
      kinds: [],
      source: "",
      destination: "",
      keywords: [],
      hostnames: [],
      userIds: [],
      userNames: [],
      userDepartments: [],
    };
  }

  function onType(h: MinInputHarness, raw: string): MinInputHarness {
    return {
      text: raw,
      draft: applyConfidenceMin(h.draft, raw),
    };
  }

  function onBlur(h: MinInputHarness): MinInputHarness {
    return { ...h, text: formatConfidenceInput(h.draft.confidenceMin) };
  }

  function onHomeKey(h: MinInputHarness): MinInputHarness {
    const next = setConfidenceMin(h.draft, CONFIDENCE_DEFAULT_MIN);
    return { text: formatConfidenceInput(next.confidenceMin), draft: next };
  }

  function onEndKey(h: MinInputHarness): MinInputHarness {
    const next = setConfidenceMin(h.draft, h.draft.confidenceMax);
    return { text: formatConfidenceInput(next.confidenceMin), draft: next };
  }

  it("preserves intermediate keystrokes while the user types 0.70", () => {
    // Starting state: input shows the formatted default "0.00".
    let h: MinInputHarness = { text: "0.00", draft: base() };

    // The user selects all, then types "0.70" character-by-character.
    // After each keystroke the displayed text must equal the raw
    // string typed so far — the bug was that every keystroke snapped
    // the text back to a two-decimal form and made sub-keystroke
    // values (like "0.") impossible to hold in the input.
    h = onType(h, "0");
    expect(h.text).toBe("0");
    expect(h.draft.confidenceMin).toBe(0);

    h = onType(h, "0.");
    expect(h.text).toBe("0.");
    // "0." parses as 0, so the committed numeric stays at 0.
    expect(h.draft.confidenceMin).toBe(0);

    h = onType(h, "0.7");
    expect(h.text).toBe("0.7");
    expect(h.draft.confidenceMin).toBe(0.7);

    h = onType(h, "0.70");
    expect(h.text).toBe("0.70");
    expect(h.draft.confidenceMin).toBe(0.7);

    // On blur, the text snaps to the canonical two-decimal string.
    h = onBlur(h);
    expect(h.text).toBe("0.70");
  });

  it("lets the user blank the field mid-edit without committing NaN", () => {
    let h: MinInputHarness = {
      text: "0.50",
      draft: { ...base(), confidenceMin: 0.5 },
    };

    h = onType(h, "");
    // Text is the raw empty string the user sees, but the committed
    // draft falls back to the previous value so no NaN leaks through.
    expect(h.text).toBe("");
    expect(h.draft.confidenceMin).toBe(0.5);

    h = onBlur(h);
    expect(h.text).toBe("0.50");
    expect(h.draft.confidenceMin).toBe(0.5);
  });

  it("Home snaps to the floor, End snaps to the current max", () => {
    let h: MinInputHarness = {
      text: "0.40",
      draft: { ...base(), confidenceMin: 0.4, confidenceMax: 0.8 },
    };

    h = onHomeKey(h);
    expect(h.text).toBe("0.00");
    expect(h.draft.confidenceMin).toBe(CONFIDENCE_DEFAULT_MIN);

    h = onEndKey(h);
    expect(h.text).toBe("0.80");
    expect(h.draft.confidenceMin).toBe(0.8);
    // The max bound is untouched when we End-key the min input, since
    // the new min equals (rather than exceeds) the current max.
    expect(h.draft.confidenceMax).toBe(0.8);
  });

  it("domain endpoint constants stay aligned with the drawer", () => {
    expect(CONFIDENCE_DEFAULT_MIN).toBe(0);
    expect(CONFIDENCE_DEFAULT_MAX).toBe(1);
  });

  // Submit via Enter while a confidence input is still focused does
  // not fire blur on that input, so the transient text is not
  // canonicalized through `onConfidenceMinBlur`. The drawer component
  // is also kept mounted by the shell between opens, so a stale raw
  // value like "0." or "" would otherwise be visible on the next open
  // even though the committed filter already used the fallback
  // numeric. `handleSubmit` resyncs both text fields from the draft
  // before calling `onApply` and clears the focus refs so the useEffect
  // can freely resync on later draft changes. This mirrors that.
  describe("submit path resynchronises transient text from the draft", () => {
    function onSubmit(h: MinInputHarness): MinInputHarness {
      return { ...h, text: formatConfidenceInput(h.draft.confidenceMin) };
    }

    it("canonicalises a blanked input on Enter-to-Apply and keeps it on reopen", () => {
      // Start from a previously committed 0.50.
      let h: MinInputHarness = {
        text: "0.50",
        draft: { ...base(), confidenceMin: 0.5 },
      };

      // User blanks the field and presses Enter without blurring.
      h = onType(h, "");
      expect(h.text).toBe("");
      // Fallback keeps the committed numeric intact.
      expect(h.draft.confidenceMin).toBe(0.5);

      // Submit resyncs the text to the committed value.
      h = onSubmit(h);
      expect(h.text).toBe("0.50");
      expect(h.draft.confidenceMin).toBe(0.5);

      // Drawer stays mounted; reopening shows the canonical value,
      // not the stale empty string the user left behind.
      expect(h.text).toBe("0.50");
    });

    it("canonicalises an intermediate value on Enter-to-Apply", () => {
      // User typed "0." but hit Enter before completing the edit.
      let h: MinInputHarness = { text: "0.00", draft: base() };
      h = onType(h, "0.");
      expect(h.text).toBe("0.");
      // "0." parses as 0, so the committed numeric is the default.
      expect(h.draft.confidenceMin).toBe(0);

      h = onSubmit(h);
      expect(h.text).toBe("0.00");
    });
  });
});
