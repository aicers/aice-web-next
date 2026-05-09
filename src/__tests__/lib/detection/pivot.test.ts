import { describe, expect, it } from "vitest";

import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import {
  applyPivotPatch,
  buildPivotPatch,
  openPivotTab,
  type PivotPatch,
  type PivotTabSummary,
} from "@/lib/detection/pivot";

function requirePatch(patch: PivotPatch | null): PivotPatch {
  if (!patch) throw new Error("patch should be non-null");
  return patch;
}

function structured(input: object = {}): Filter {
  return { mode: "structured", input };
}

describe("buildPivotPatch", () => {
  it("maps origAddr to a FROM endpoint host patch", () => {
    const patch = buildPivotPatch("origAddr", { raw: "10.0.0.5" });
    expect(patch).toEqual({
      kind: "endpointHost",
      direction: "FROM",
      host: "10.0.0.5",
      displayValue: "10.0.0.5",
    });
  });

  it("maps respAddr to a TO endpoint host patch", () => {
    const patch = buildPivotPatch("respAddr", { raw: "203.0.113.45" });
    expect(patch).toEqual({
      kind: "endpointHost",
      direction: "TO",
      host: "203.0.113.45",
      displayValue: "203.0.113.45",
    });
  });

  it("maps origCountry to the countries array", () => {
    const patch = buildPivotPatch("origCountry", { raw: "KR" });
    expect(patch).toEqual({
      kind: "stringArray",
      field: "countries",
      value: "KR",
      displayValue: "KR",
    });
  });

  it("maps respCountry to the countries array", () => {
    const patch = buildPivotPatch("respCountry", { raw: "US" });
    expect(patch).toEqual({
      kind: "stringArray",
      field: "countries",
      value: "US",
      displayValue: "US",
    });
  });

  it("maps hostname / userId / userName / userDepartment to their tag arrays", () => {
    expect(buildPivotPatch("hostname", { raw: "host01" })).toMatchObject({
      kind: "stringArray",
      field: "hostnames",
      value: "host01",
    });
    expect(buildPivotPatch("userId", { raw: "jdoe" })).toMatchObject({
      kind: "stringArray",
      field: "userIds",
      value: "jdoe",
    });
    expect(buildPivotPatch("userName", { raw: "Jane" })).toMatchObject({
      kind: "stringArray",
      field: "userNames",
      value: "Jane",
    });
    expect(buildPivotPatch("userDepartment", { raw: "Eng" })).toMatchObject({
      kind: "stringArray",
      field: "userDepartments",
      value: "Eng",
    });
  });

  it("maps kind to the kinds array", () => {
    expect(
      buildPivotPatch("kind", { raw: "HttpThreat", display: "HTTP Threat" }),
    ).toEqual({
      kind: "stringArray",
      field: "kinds",
      value: "HttpThreat",
      displayValue: "HTTP Threat",
    });
  });

  it("maps category to a numberArray patch and level to a levelArray patch", () => {
    expect(
      buildPivotPatch("category", { raw: 6, display: "Lateral Movement" }),
    ).toEqual({
      kind: "numberArray",
      field: "categories",
      value: 6,
      displayValue: "Lateral Movement",
    });
    expect(buildPivotPatch("level", { raw: "HIGH", display: "High" })).toEqual({
      kind: "levelArray",
      value: "HIGH",
      displayValue: "High",
    });
  });

  it("maps direction to a directionArray patch", () => {
    expect(buildPivotPatch("direction", { raw: "INBOUND" })).toEqual({
      kind: "directionArray",
      value: "INBOUND",
      displayValue: "INBOUND",
    });
  });

  it("rejects empty / blank string values", () => {
    expect(buildPivotPatch("hostname", { raw: "" })).toBeNull();
    expect(buildPivotPatch("hostname", { raw: "   " })).toBeNull();
  });

  it("rejects unrecognised category / level inputs", () => {
    expect(buildPivotPatch("category", { raw: "RECONNAISSANCE" })).toBeNull();
    expect(buildPivotPatch("level", { raw: "NOT_A_LEVEL" })).toBeNull();
    expect(buildPivotPatch("level", { raw: 3 })).toBeNull();
  });

  it("rejects a malformed direction value", () => {
    expect(buildPivotPatch("direction", { raw: "EXTERNAL" })).toBeNull();
  });
});

describe("applyPivotPatch", () => {
  it("appends a new endpoint entry on origAddr pivot", () => {
    const patch = buildPivotPatch("origAddr", { raw: "10.0.0.5" });
    if (!patch) throw new Error("patch should be non-null");
    const result = applyPivotPatch(structured(), [], patch);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      kind: "host",
      host: "10.0.0.5",
      direction: "SOURCE",
      selected: true,
    });
    expect(result.filter.mode).toBe("structured");
    if (result.filter.mode !== "structured") return;
    expect(result.filter.input.endpoints).toEqual([
      {
        direction: "FROM",
        custom: { hosts: ["10.0.0.5"], networks: [], ranges: [] },
      },
    ]);
  });

  it("does not duplicate an endpoint host already present in the same direction", () => {
    const existing: EndpointEntry = {
      id: "id-1",
      raw: "10.0.0.5",
      kind: "host",
      host: "10.0.0.5",
      direction: "SOURCE",
      selected: true,
    };
    const patch = buildPivotPatch("origAddr", { raw: "10.0.0.5" });
    if (!patch) throw new Error("patch should be non-null");
    const result = applyPivotPatch(structured(), [existing], patch);
    expect(result.endpoints).toHaveLength(1);
  });

  it("dedupes string-array values", () => {
    const patch = buildPivotPatch("origCountry", { raw: "KR" });
    if (!patch) throw new Error();
    const filter = structured({ countries: ["KR"] });
    const result = applyPivotPatch(filter, [], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.countries).toEqual(["KR"]);
  });

  it("appends to existing string-array values when not present", () => {
    const patch = buildPivotPatch("hostname", { raw: "host02" });
    if (!patch) throw new Error();
    const filter = structured({ hostnames: ["host01"] });
    const result = applyPivotPatch(filter, [], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.hostnames).toEqual(["host01", "host02"]);
  });

  it("collapses 'all directions' to the single clicked value", () => {
    const patch = buildPivotPatch("direction", { raw: "INBOUND" });
    if (!patch) throw new Error();
    // No directions on the input encodes "no filter" — pivoting must
    // narrow to the single clicked value rather than re-emitting all
    // three.
    const result = applyPivotPatch(structured({}), [], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.directions).toEqual(["INBOUND"]);
  });

  it("returns the filter untouched for query-mode pivots", () => {
    const patch = buildPivotPatch("kind", { raw: "HttpThreat" });
    if (!patch) throw new Error();
    const filter: Filter = { mode: "query", text: "free" };
    const result = applyPivotPatch(filter, [], patch);
    expect(result.filter).toEqual({ mode: "query", text: "free" });
  });

  it("preserves predefined endpoint references on an endpointHost pivot", () => {
    // Reviewer Round 2: a tab filtered to a predefined network has
    // no `EndpointEntry` UI mirror entry for it, so re-emitting the
    // wire payload purely from the mirror erased the predefined
    // reference and broadened the filter. The pivot must keep the
    // predefined entry alongside the freshly added custom host.
    const patch = buildPivotPatch("origAddr", { raw: "10.0.0.5" });
    if (!patch) throw new Error();
    const filter = structured({
      endpoints: [{ direction: "FROM", predefined: "net-1" }],
    });
    const result = applyPivotPatch(filter, [], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.endpoints).toEqual([
      { direction: "FROM", predefined: "net-1" },
      {
        direction: "FROM",
        custom: { hosts: ["10.0.0.5"], networks: [], ranges: [] },
      },
    ]);
  });

  it("keeps predefined references from the opposite direction on an endpointHost pivot", () => {
    const patch = buildPivotPatch("respAddr", { raw: "203.0.113.7" });
    if (!patch) throw new Error();
    const filter = structured({
      endpoints: [{ direction: "FROM", predefined: "net-1" }],
    });
    const result = applyPivotPatch(filter, [], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.endpoints).toEqual([
      { direction: "FROM", predefined: "net-1" },
      {
        direction: "TO",
        custom: { hosts: ["203.0.113.7"], networks: [], ranges: [] },
      },
    ]);
  });

  it("does not duplicate custom entries co-located with a predefined reference", () => {
    // Schema permits direction + predefined + custom on the same
    // entry. The custom payload is mirrored in `EndpointEntry`, so
    // preserving the original entry verbatim would emit the same
    // hosts twice (once via the mirror rebuild, once via the
    // preserved entry). Strip the predefined entry down to just the
    // predefined reference.
    const existing: EndpointEntry = {
      id: "id-existing",
      raw: "10.0.0.1",
      kind: "host",
      host: "10.0.0.1",
      direction: "SOURCE",
      selected: true,
    };
    const patch = buildPivotPatch("origAddr", { raw: "10.0.0.5" });
    if (!patch) throw new Error();
    const filter = structured({
      endpoints: [
        {
          direction: "FROM",
          predefined: "net-1",
          custom: { hosts: ["10.0.0.1"], networks: [], ranges: [] },
        },
      ],
    });
    const result = applyPivotPatch(filter, [existing], patch);
    if (result.filter.mode !== "structured") throw new Error();
    expect(result.filter.input.endpoints).toEqual([
      { direction: "FROM", predefined: "net-1" },
      {
        direction: "FROM",
        custom: {
          hosts: ["10.0.0.1", "10.0.0.5"],
          networks: [],
          ranges: [],
        },
      },
    ]);
  });
});

describe("openPivotTab", () => {
  function summary(id: string, filter: Filter): PivotTabSummary {
    return { id, identity: { filter, period: null } };
  }

  it("toasts when the patch would only re-narrow the active tab", () => {
    const filter = structured({ countries: ["KR"] });
    const action = openPivotTab({
      patch: requirePatch(buildPivotPatch("origCountry", { raw: "KR" })),
      active: { id: "tab-a", filter, endpoints: [], period: null },
      tabs: [summary("tab-a", filter)],
      maxTabs: 8,
    });
    expect(action.kind).toBe("toastDuplicate");
  });

  it("focuses an existing tab whose filter matches the target", () => {
    const active = structured({ countries: ["US"] });
    const target = structured({ countries: ["US", "KR"] });
    const action = openPivotTab({
      patch: requirePatch(buildPivotPatch("origCountry", { raw: "KR" })),
      active: { id: "tab-a", filter: active, endpoints: [], period: null },
      tabs: [summary("tab-a", active), summary("tab-b", target)],
      maxTabs: 8,
    });
    expect(action.kind).toBe("focusTab");
    if (action.kind !== "focusTab") return;
    expect(action.tabId).toBe("tab-b");
  });

  it("creates a new tab when no existing tab matches and the cap allows", () => {
    const filter = structured({});
    const action = openPivotTab({
      patch: requirePatch(buildPivotPatch("origCountry", { raw: "KR" })),
      active: { id: "tab-a", filter, endpoints: [], period: "1h" },
      tabs: [summary("tab-a", filter)],
      maxTabs: 8,
    });
    expect(action.kind).toBe("createTab");
    if (action.kind !== "createTab") return;
    if (action.filter.mode !== "structured") throw new Error();
    expect(action.filter.input.countries).toEqual(["KR"]);
    expect(action.period).toBe("1h");
  });

  it("toasts when the wrapper is at the tab cap", () => {
    const filter = structured({});
    const tabs: PivotTabSummary[] = Array.from({ length: 8 }, (_, i) =>
      summary(`tab-${i}`, structured({ kinds: [`Kind${i}`] })),
    );
    const action = openPivotTab({
      patch: requirePatch(buildPivotPatch("origCountry", { raw: "KR" })),
      active: { id: "tab-0", filter, endpoints: [], period: null },
      tabs,
      maxTabs: 8,
    });
    // Active tab's filter is the empty structured filter (which !=
    // any of the other 8 tabs). Capacity is at the limit, so the
    // helper should toast cap-reached rather than creating.
    expect(action.kind).toBe("toastCapReached");
  });
});
