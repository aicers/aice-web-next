import { describe, expect, it, vi } from "vitest";

// Mock React + UI dependencies so we can import the pure helper
// without pulling the client component's runtime.
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
  startTransition: (fn: () => void) => fn(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => () => "",
  useLocale: () => "en",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/detection",
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("lucide-react", () => ({
  Bookmark: "span",
  ChevronRight: "span",
  SlidersHorizontal: "span",
  Star: "span",
  X: "span",
  XIcon: "span",
}));
vi.mock("@/app/[locale]/(dashboard)/detection/actions", () => ({
  runEventQuery: vi.fn(),
}));
vi.mock("@/app/[locale]/(dashboard)/detection/sensor-actions", () => ({
  fetchSensors: vi.fn(),
}));
vi.mock("@/components/ui/badge", () => ({ Badge: "span" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: "div",
  SheetContent: "div",
  SheetDescription: "div",
  SheetHeader: "div",
  SheetTitle: "div",
}));
vi.mock("@/components/detection/filter-drawer", () => ({
  FilterDrawer: "div",
}));
vi.mock("@/components/detection/sensor-multi-select", () => ({}));
vi.mock("@/components/detection/result-list", () => ({
  ResultList: "div",
}));

import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import type { Filter } from "@/lib/detection/filter";
import type { DetectionFilterDraft } from "@/lib/detection/filter-draft";

type ShellModule = typeof import("@/components/detection/detection-shell");

const BASE_DRAFT: DetectionFilterDraft = {
  period: null,
  startLocal: "2026-04-22T00:00",
  endLocal: "2026-04-22T01:00",
  startIso: "2026-04-22T00:00:00.000Z",
  endIso: "2026-04-22T01:00:00.000Z",
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

describe("buildAppliedFilter", () => {
  it("throws when the draft has no ISO range", () => {
    const committed: Filter = { mode: "structured", input: {} };
    expect(() =>
      buildAppliedFilter(committed, { ...BASE_DRAFT, startIso: null }, true),
    ).toThrow();
  });

  it("omits `sensors` when the endpoint is absent", () => {
    const committed: Filter = { mode: "structured", input: {} };
    const result = buildAppliedFilter(
      committed,
      { ...BASE_DRAFT, sensorIds: ["s1"] },
      false,
    );
    expect(result.mode).toBe("structured");
    if (result.mode !== "structured") throw new Error("unreachable");
    expect(result.input.sensors).toBeUndefined();
  });

  it("strips a prior `sensors` when the endpoint is absent", () => {
    // Regression: the drawer builds the next filter by spreading
    // the previously committed input. Without an explicit strip,
    // a prior `sensors` survives into the new filter even though
    // the endpoint is now absent — the fallback acceptance
    // forbids any `sensors` value reaching REview.
    const committed: Filter = {
      mode: "structured",
      input: { sensors: ["old-1", "old-2"] },
    };
    const result = buildAppliedFilter(committed, BASE_DRAFT, false);
    if (result.mode !== "structured") throw new Error("unreachable");
    expect(result.input.sensors).toBeUndefined();
  });

  it("clears `sensors` when the user deselects all and re-applies", () => {
    // Regression: select sensors → Apply → committed now carries
    // `sensors: [...]`. Reopen drawer → Clear selection → Apply
    // with `sensorIds: []`. The submitted filter must drop the
    // prior IDs; otherwise "Clear selection" is a silent no-op.
    const committed: Filter = {
      mode: "structured",
      input: { sensors: ["a", "b"] },
    };
    const result = buildAppliedFilter(
      committed,
      { ...BASE_DRAFT, sensorIds: [] },
      true,
    );
    if (result.mode !== "structured") throw new Error("unreachable");
    expect(result.input.sensors).toBeUndefined();
  });

  it("replaces prior `sensors` with the draft selection", () => {
    const committed: Filter = {
      mode: "structured",
      input: { sensors: ["old"] },
    };
    const result = buildAppliedFilter(
      committed,
      { ...BASE_DRAFT, sensorIds: ["new-1", "new-2"] },
      true,
    );
    if (result.mode !== "structured") throw new Error("unreachable");
    expect(result.input.sensors).toEqual(["new-1", "new-2"]);
  });

  it("always rewrites start/end from the draft", () => {
    const committed: Filter = {
      mode: "structured",
      input: {
        start: "2020-01-01T00:00:00.000Z",
        end: "2020-01-02T00:00:00.000Z",
      },
    };
    const result = buildAppliedFilter(committed, BASE_DRAFT, false);
    if (result.mode !== "structured") throw new Error("unreachable");
    expect(result.input.start).toBe(BASE_DRAFT.startIso);
    expect(result.input.end).toBe(BASE_DRAFT.endIso);
  });
});

describe("sensorStateForCache", () => {
  let sensorStateForCache: ShellModule["sensorStateForCache"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    sensorStateForCache = mod.sensorStateForCache;
  });

  it("treats an idle cache as loading so the first open does not show Coming soon", () => {
    expect(sensorStateForCache({ status: "idle" })).toBe("loading");
  });

  it("treats an in-flight fetch as loading", () => {
    expect(sensorStateForCache({ status: "loading" })).toBe("loading");
  });

  it("surfaces a prior transient failure as a retryable error, not Coming soon", () => {
    // Regression anchor for the round-3 reviewer concern: a
    // transient fetch failure must not be explained with the same
    // "endpoint absent" copy as a genuinely missing endpoint.
    expect(sensorStateForCache({ status: "error" })).toBe("error");
  });

  it("maps a loaded-but-endpoint-absent cache to the Coming soon fallback", () => {
    expect(
      sensorStateForCache({
        status: "loaded",
        endpointAvailable: false,
        options: [],
      }),
    ).toBe("unavailable");
  });

  it("maps a loaded cache with endpoint present to the functional ready state", () => {
    expect(
      sensorStateForCache({
        status: "loaded",
        endpointAvailable: true,
        options: [{ id: "s1", name: "Alpha" }],
      }),
    ).toBe("ready");
  });
});

describe("shouldTriggerSensorFetch", () => {
  let shouldTriggerSensorFetch: ShellModule["shouldTriggerSensorFetch"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    shouldTriggerSensorFetch = mod.shouldTriggerSensorFetch;
  });

  it("fetches on the first drawer open when the cache is still idle", () => {
    // Regression (Reviewer Round 6 #1): the chip-body open path must
    // kick off the lazy sensor fetch on an idle cache, otherwise
    // `sensorStateForCache` keeps reporting "loading" and the
    // Sensor control stays stuck in its disabled placeholder.
    expect(shouldTriggerSensorFetch({ status: "idle" })).toBe(true);
  });

  it("retries after a prior transient failure", () => {
    expect(shouldTriggerSensorFetch({ status: "error" })).toBe(true);
  });

  it("does not re-fetch while a request is already in flight", () => {
    expect(shouldTriggerSensorFetch({ status: "loading" })).toBe(false);
  });

  it("does not re-fetch when a successful response is cached", () => {
    expect(
      shouldTriggerSensorFetch({
        status: "loaded",
        endpointAvailable: true,
        options: [{ id: "s1", name: "Alpha" }],
      }),
    ).toBe(false);
  });
});

describe("shouldOpenEndpointPanelForFocus", () => {
  let shouldOpenEndpointPanelForFocus: ShellModule["shouldOpenEndpointPanelForFocus"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    shouldOpenEndpointPanelForFocus = mod.shouldOpenEndpointPanelForFocus;
  });

  it("expands the Network/IP advanced panel for the endpoints aggregate chip", () => {
    expect(shouldOpenEndpointPanelForFocus("endpoints")).toBe(true);
  });

  it.each([
    "period",
    "timeRange",
    "direction",
    "confidence",
    "sensor",
    "source",
    "destination",
    "keywords",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
    "levels",
    "countries",
    "learningMethods",
    "categories",
    "kinds",
  ] as const)("clears the endpoint panel flag so a prior activation does not leak into %s", (focus) => {
    // Regression (Reviewer Round 6 #2): without this reset, clicking
    // a Network/IP chip followed by, say, a Period chip would
    // reopen the drawer with the endpoint panel still expanded —
    // not the "focused on that field" behavior the issue calls for.
    expect(shouldOpenEndpointPanelForFocus(focus)).toBe(false);
  });
});

describe("ENDPOINT_CHIP_FOCUS", () => {
  it("routes endpoint chip activation through the chip-body focus path", async () => {
    // Regression (Reviewer Round 7 #1): the Network/IP chip used to
    // call `openDrawer({ openEndpointPanel: true })`, which clears
    // `focusField` — so the drawer would expand the advanced panel
    // but skip the scroll-to-field step every other chip receives.
    // The shell now uses this exported constant on that onActivate
    // path, so endpoint chips share the same `openDrawerFocused`
    // contract as period / direction / confidence / sensor / source
    // / destination / text-and-tag / multi-select chips.
    const mod = await import("@/components/detection/detection-shell");
    expect(mod.ENDPOINT_CHIP_FOCUS).toBe("endpoints");
    // And the combined wiring: routing endpoint chips through the
    // focus path still expands the Network/IP advanced panel, so
    // the previous behavior is preserved on top of the new
    // scroll-to-field behavior.
    expect(mod.shouldOpenEndpointPanelForFocus(mod.ENDPOINT_CHIP_FOCUS)).toBe(
      true,
    );
  });
});
