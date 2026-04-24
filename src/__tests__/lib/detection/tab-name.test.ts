import { describe, expect, it } from "vitest";

import type { EndpointChip, FilterChip } from "@/lib/detection";
import { AUTO_TAB_NAME_CHIP_CAP, buildAutoTabName } from "@/lib/detection";

const LABELS = {
  emptyTab: "New tab",
  separator: " · ",
  moreSuffix: (count: number) => `+${count}`,
};

const chip = (id: string, value: string): FilterChip => ({
  id,
  label: id,
  value,
});

describe("buildAutoTabName", () => {
  it("returns the empty-tab label when no chips are present", () => {
    expect(buildAutoTabName([], LABELS)).toBe("New tab");
  });

  it("returns a single chip's value verbatim", () => {
    expect(buildAutoTabName([chip("period", "Last 1h")], LABELS)).toBe(
      "Last 1h",
    );
  });

  it("joins two chip values with the separator", () => {
    expect(
      buildAutoTabName(
        [chip("period", "Last 1h"), chip("level", "High")],
        LABELS,
      ),
    ).toBe("Last 1h · High");
  });

  it("appends a `+N` suffix when the chip list exceeds the cap", () => {
    expect(AUTO_TAB_NAME_CHIP_CAP).toBe(2);
    const chips = [
      chip("period", "Last 1h"),
      chip("level", "High"),
      chip("dir", "Outbound"),
      chip("src", "10.0.0.1"),
    ];
    expect(buildAutoTabName(chips, LABELS)).toBe("Last 1h · High · +2");
  });

  describe("endpoint chip contribution", () => {
    const endpoint = (id: string, label: string): EndpointChip => ({
      id,
      label,
      aggregate: false,
    });

    it("includes an endpoint chip when no structured chips are present", () => {
      expect(
        buildAutoTabName([], LABELS, [endpoint("e1", "Src 10.0.0.1")]),
      ).toBe("Src 10.0.0.1");
    });

    it("differentiates two tabs that share structured chips but differ by endpoint rows", () => {
      const chips = [chip("period", "Last 1h")];
      const a = buildAutoTabName(chips, LABELS, [
        endpoint("e1", "Src 10.0.0.1"),
      ]);
      const b = buildAutoTabName(chips, LABELS, [
        endpoint("e1", "Dst 10.0.0.2"),
      ]);
      expect(a).toBe("Last 1h · Src 10.0.0.1");
      expect(b).toBe("Last 1h · Dst 10.0.0.2");
      expect(a).not.toBe(b);
    });

    it("reserves an endpoint slot in the head so endpoint-only switches stay distinguishable", () => {
      // Regression: two tabs whose structured filter is identical but
      // whose endpoint rows differ (e.g. `Src 10.0.0.1` vs `Dst
      // 10.0.0.2`) must produce different auto-names. The earlier
      // implementation concatenated structured tokens first and then
      // sliced to the cap, which flattened both tabs to `Last 1h ·
      // High · +1` and made endpoint-only context switches invisible.
      const chips = [chip("period", "Last 1h"), chip("level", "High")];
      const a = buildAutoTabName(chips, LABELS, [
        endpoint("e1", "Src 10.0.0.1"),
      ]);
      const b = buildAutoTabName(chips, LABELS, [
        endpoint("e2", "Dst 10.0.0.2"),
      ]);
      expect(a).toBe("Last 1h · Src 10.0.0.1 · +1");
      expect(b).toBe("Last 1h · Dst 10.0.0.2 · +1");
      expect(a).not.toBe(b);
    });

    it("counts endpoint chips toward the cap / `+N` overflow", () => {
      const chips = [chip("period", "Last 1h"), chip("level", "High")];
      expect(
        buildAutoTabName(chips, LABELS, [
          endpoint("e1", "Src 10.0.0.1"),
          endpoint("e2", "Src 10.0.0.2"),
        ]),
      ).toBe("Last 1h · Src 10.0.0.1 · +2");
    });

    it("renders an aggregate endpoint chip verbatim", () => {
      expect(
        buildAutoTabName([], LABELS, [
          {
            id: "endpoint-aggregate",
            label: "Network: 5 rules",
            aggregate: true,
          },
        ]),
      ).toBe("Network: 5 rules");
    });
  });
});
