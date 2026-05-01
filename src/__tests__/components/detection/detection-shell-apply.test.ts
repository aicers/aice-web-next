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
vi.mock("@/components/detection/csv-export-dialog", () => ({
  CsvExportConfirmDialog: "div",
}));
vi.mock("@/components/detection/use-csv-export", () => ({
  useCsvExport: () => ({
    status: { kind: "idle" },
    start: vi.fn(),
    confirmAndContinue: vi.fn(),
    cancelConfirmation: vi.fn(),
    dismissError: vi.fn(),
  }),
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
  customerIds: [],
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

describe("customerSelectionLiveForCache", () => {
  // Reviewer Round 8: this helper is the source of the
  // `customerSelectionLive` boolean that `handleApply` /
  // `handleSaveRequest` pass into `buildAppliedFilter`. The
  // contract — "filter submits no `customers` value until the
  // customer list is successfully loaded, and the empty-scope path
  // never submits one" — relies on every non-(`loaded` + non-empty)
  // state mapping to `false`. These cases pin that mapping.
  let customerSelectionLiveForCache: ShellModule["customerSelectionLiveForCache"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    customerSelectionLiveForCache = mod.customerSelectionLiveForCache;
  });

  it("treats an idle cache as not live so the first open cannot submit", () => {
    expect(customerSelectionLiveForCache({ status: "idle" })).toBe(false);
  });

  it("treats an in-flight fetch as not live (loading branch)", () => {
    expect(customerSelectionLiveForCache({ status: "loading" })).toBe(false);
  });

  it("treats a refresh-to-error transition as not live", () => {
    // Regression: the user opened the drawer with a non-empty
    // customer list, selected some customers, then hit `↻` which
    // failed. The cache becomes `error` while the draft still
    // carries the prior IDs. Apply / Save must not re-emit them.
    expect(customerSelectionLiveForCache({ status: "error" })).toBe(false);
  });

  it("treats refresh-to-empty (`No customer access`) as not live", () => {
    // Regression: a manual refresh transitioning the cache to
    // `loaded` + zero options is the empty-scope affordance. The
    // issue requires that this path never submits a `customers`
    // value, even when the draft holds prior IDs from a bookmark
    // or saved filter.
    expect(
      customerSelectionLiveForCache({
        status: "loaded",
        kind: "empty",
        options: [],
      }),
    ).toBe(false);
  });

  it("treats a loaded cache with at least one option as live", () => {
    expect(
      customerSelectionLiveForCache({
        status: "loaded",
        kind: "assigned",
        options: [{ id: 1, name: "Customer A" }],
      }),
    ).toBe(true);
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

describe("applyCommitDispatchReset", () => {
  let applyCommitDispatchReset: ShellModule["applyCommitDispatchReset"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    applyCommitDispatchReset = mod.applyCommitDispatchReset;
  });

  // Helper: exercise the helper's functional `setQuickPeekEvent`
  // setter with a caller-provided `prev` so assertions can observe
  // what the returned value is and what `hadPeek` gets reported.
  function runDispatch(
    prev: unknown,
    extras: { clearQuickPeekUrl?: ReturnType<typeof vi.fn> } = {},
  ) {
    const setQueryEpoch = vi.fn();
    let finalValue: unknown = "UNSET";
    const setQuickPeekEvent = vi.fn((fn: (p: unknown) => unknown) => {
      finalValue = fn(prev);
    });
    applyCommitDispatchReset({
      setQueryEpoch,
      setQuickPeekEvent: setQuickPeekEvent as never,
      clearQuickPeekUrl: extras.clearQuickPeekUrl as never,
    });
    return { setQueryEpoch, setQuickPeekEvent, finalValue };
  }

  it("bumps the query epoch synchronously at dispatch", () => {
    // Reviewer Round 12: advancing `queryEpoch` must happen at the
    // moment the commit is dispatched, not after the replacement
    // slice resolves. Otherwise `ResultList` keeps reconciling
    // per-row state (MorePopover open/close, focus) across the
    // committed transition until the network returns.
    const { setQueryEpoch } = runDispatch(null);
    expect(setQueryEpoch).toHaveBeenCalledTimes(1);
    const updater = setQueryEpoch.mock.calls[0]?.[0] as (n: number) => number;
    expect(typeof updater).toBe("function");
    expect(updater(0)).toBe(1);
    expect(updater(7)).toBe(8);
  });

  it("closes Quick peek synchronously at dispatch", () => {
    // Reviewer Round 12: closing Quick peek only after the async
    // response lands leaves a window during the round-trip where
    // the inspector and its Open investigation button still point
    // at a row the newly committed filter no longer describes.
    const { setQuickPeekEvent, finalValue } = runDispatch({ __typename: "X" });
    expect(setQuickPeekEvent).toHaveBeenCalledTimes(1);
    expect(finalValue).toBeNull();
  });

  it("reports hadPeek=true so the URL sink strips the token when a peek was open", () => {
    // Reviewer Round 3: Refresh goes through `runQueryFor`, which
    // closes the in-memory peek via this helper. Before the sink
    // was added, the tab URL still carried the stale `?event=`
    // token, so reload would resurrect the selection.
    const clearQuickPeekUrl = vi.fn();
    runDispatch({ __typename: "HttpThreat" }, { clearQuickPeekUrl });
    expect(clearQuickPeekUrl).toHaveBeenCalledTimes(1);
    expect(clearQuickPeekUrl).toHaveBeenCalledWith({ hadPeek: true });
  });

  it("reports hadPeek=false so the URL sink preserves the token when no peek is open", () => {
    // Reviewer Round 7: the "reload with `?event=` → transient
    // backend error → Refresh" sequence leaves the URL token
    // pending a successful retry while `quickPeekEvent` stays null.
    // Unconditionally stripping the URL on dispatch loses the
    // selection URL state before the retry's slice can match it.
    // The dispatch now reports `hadPeek: false` so the `runQueryFor`
    // sink can no-op and let the post-fetch reconcile decide.
    const clearQuickPeekUrl = vi.fn();
    runDispatch(null, { clearQuickPeekUrl });
    expect(clearQuickPeekUrl).toHaveBeenCalledTimes(1);
    expect(clearQuickPeekUrl).toHaveBeenCalledWith({ hadPeek: false });
  });

  it("omits the URL sink cleanly when no sink is provided", () => {
    // The sink is optional so existing tests and callers that do
    // not need the URL cleanup (unit-level assertions on the
    // state-reset contract alone) stay wire-compatible.
    expect(() => runDispatch(null)).not.toThrow();
  });
});

describe("applyTransitionReset — Reviewer Round 3", () => {
  // `runQueryFor` (Apply / chip ×) routes the dispatch-time reset
  // through this helper so the multi-tab wrapper's snapshot never
  // observes "new filter + old cached rows/cursor" during the
  // async REview round-trip. Without these resets a tab-switch
  // mid-Apply parked a transient snapshot
  // `{ filter: NEW, pagination: OLD_CURSOR, events: OLD_ROWS }`
  // into the tab, and on switch-back the wrapper's loading-stripping
  // remount rendered the OLD rows as a ready cached result for the
  // NEW filter — while the URL effect reintroduced stale
  // after= / before= / last= cursors on the new filter's URL.
  let applyTransitionReset: ShellModule["applyTransitionReset"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    applyTransitionReset = mod.applyTransitionReset;
  });

  function runReset(args: { pageSize: 25 | 50 | 100 | 200 }) {
    const setters = {
      setPagination: vi.fn(),
      setEvents: vi.fn(),
      setEventKeys: vi.fn(),
      setTotalCount: vi.fn(),
      setPageInfo: vi.fn(),
      setLastUpdatedMs: vi.fn(),
      setTotalCountRef: vi.fn(),
    };
    applyTransitionReset(setters, args);
    return setters;
  }

  it("pins pagination to HEAD + page=1 at the caller's pageSize", () => {
    const setters = runReset({ pageSize: 50 });
    expect(setters.setPagination).toHaveBeenCalledTimes(1);
    expect(setters.setPagination).toHaveBeenCalledWith({
      pageSize: 50,
      anchor: { kind: "head" },
      page: 1,
    });
  });

  it("preserves a non-default page size so a tab on 200/page stays at 200 after Apply", () => {
    // Regression: a naive reset to INITIAL_PAGINATION_STATE would
    // silently teleport the tab back to the default pageSize on
    // every Apply — Apply is supposed to reset the cursor, not the
    // operator's chosen page size.
    const setters = runReset({ pageSize: 200 });
    const call = setters.setPagination.mock.calls[0]?.[0] as {
      pageSize: number;
    };
    expect(call.pageSize).toBe(200);
  });

  it("clears events / eventKeys / totalCount / pageInfo so snapshots cannot retain old rows under a new filter", () => {
    const setters = runReset({ pageSize: 50 });
    expect(setters.setEvents).toHaveBeenCalledWith([]);
    expect(setters.setEventKeys).toHaveBeenCalledWith([]);
    expect(setters.setTotalCount).toHaveBeenCalledWith(null);
    expect(setters.setPageInfo).toHaveBeenCalledWith(null);
  });

  it("clears the totalCount ref so a mid-flight tail-anchor request does not read a stale total", () => {
    const setters = runReset({ pageSize: 50 });
    expect(setters.setTotalCountRef).toHaveBeenCalledWith(null);
  });

  it("clears lastUpdatedMs so a mid-flight switch-back does not show a stale 'Updated Xm ago' over an empty results panel", () => {
    const setters = runReset({ pageSize: 50 });
    expect(setters.setLastUpdatedMs).toHaveBeenCalledWith(null);
  });
});

describe("invalidateInFlightOnUnmount — Reviewer Round 5", () => {
  // The multi-tab wrapper unmounts the shell on tab switch. An Apply
  // / Refresh / paginator request that was in flight when the switch
  // happened still resolves into the unmounted shell's closures —
  // and would otherwise pass the `latestRequestIdRef` / walk-id
  // checks and run global URL side effects (Quick peek strip,
  // pagination persist) under the **next** tab's `?tab=`. Bumping
  // both refs on unmount short-circuits those continuations so the
  // operator's address bar cannot end up with B's tab id paired
  // with A's filter / page.
  let invalidateInFlightOnUnmount: ShellModule["invalidateInFlightOnUnmount"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    invalidateInFlightOnUnmount = mod.invalidateInFlightOnUnmount;
  });

  it("advances the request id so an in-flight dispatch is dropped", () => {
    // Regression: without the bump, the resolved Promise's success
    // branch passes `latestRequestIdRef.current === requestId` and
    // calls `reconcileQuickPeekAgainstSlice`, which mutates the
    // currently-active tab's `?event=` URL token.
    const refs = {
      latestRequestIdRef: { current: 4 },
      latestWalkIdRef: { current: 0 },
    };
    invalidateInFlightOnUnmount(refs);
    expect(refs.latestRequestIdRef.current).toBe(5);
  });

  it("advances the walk id so a Go-to-page walker drops its remaining steps", () => {
    // Regression: a multi-step walk's `persistPaginationToUrl` call
    // is gated on `latestWalkIdRef.current === walkId`. Without the
    // bump the walker would also write the unmounted tab's filter
    // into the URL under the new active tab's id.
    const refs = {
      latestRequestIdRef: { current: 0 },
      latestWalkIdRef: { current: 7 },
    };
    invalidateInFlightOnUnmount(refs);
    expect(refs.latestWalkIdRef.current).toBe(8);
  });

  it("advances both ids in a single call", () => {
    // The cleanup fires once per unmount and must invalidate every
    // continuation that gates on either id; otherwise a paginator
    // walk in flight at unmount-time could still touch the URL even
    // though the next dispatch was correctly dropped.
    const refs = {
      latestRequestIdRef: { current: 1 },
      latestWalkIdRef: { current: 1 },
    };
    invalidateInFlightOnUnmount(refs);
    expect(refs.latestRequestIdRef.current).toBe(2);
    expect(refs.latestWalkIdRef.current).toBe(2);
  });
});

describe("shouldResumeQueryOnMount — Reviewer Round 4 (item 1)", () => {
  // When the operator applies a filter in tab A and switches to tab B
  // before the request resolves, the wrapper unmounts tab A's shell.
  // The in-flight REview response then lands in a dead React tree —
  // its setState closures are no-ops under the unmounted instance, so
  // tab A's cache never receives the fresh rows. The wrapper now
  // threads the snapshot's `loading: true` flag back into
  // `initialResult.loading`, and this predicate decides whether a
  // freshly-mounted shell should resume the query by re-issuing the
  // same request at the snapshot's pagination.
  let shouldResumeQueryOnMount: (loading: boolean | undefined) => boolean;

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    shouldResumeQueryOnMount = mod.shouldResumeQueryOnMount;
  });

  it("resumes when the snapshot flagged an in-flight committed query", () => {
    // Tab A was mid-Apply when the operator switched to tab B; on
    // switch-back, the shell must re-dispatch so the request is not
    // silently dropped.
    expect(shouldResumeQueryOnMount(true)).toBe(true);
  });

  it("does not resume when the snapshot was idle", () => {
    // The common case — every tab switch that did not catch a
    // committed query mid-flight should land at a plain cache hit
    // without hitting the network.
    expect(shouldResumeQueryOnMount(false)).toBe(false);
  });

  it("does not resume when the snapshot flag is absent (SSR bootstrap)", () => {
    // The server page seeds the initial result without a `loading`
    // field; a bootstrap tab must not auto-redispatch on first mount.
    expect(shouldResumeQueryOnMount(undefined)).toBe(false);
  });
});

describe("quickPeekResetKey", () => {
  let quickPeekResetKey: ShellModule["quickPeekResetKey"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    quickPeekResetKey = mod.quickPeekResetKey;
  });

  const addressable = {
    __typename: "HttpThreat" as const,
    sensor: "sensor-1",
    time: "2026-04-22T00:00:00.000Z",
    origAddr: "10.0.0.5",
    origPort: 49152,
    respAddr: "203.0.113.45",
    respPort: 443,
    proto: 6,
    level: "HIGH" as const,
  };

  it("produces a stable key for the same event", () => {
    // Regression (Reviewer Round 6 #1): the inspector's React `key`
    // must not churn between renders of the same selection — that
    // would remount on every state change and flicker the peek.
    expect(quickPeekResetKey(addressable as never)).toBe(
      quickPeekResetKey(addressable as never),
    );
  });

  it("produces different keys for different addressable events", () => {
    // Regression (Reviewer Round 6 #1): switching rows on the
    // desktop inline pane must remount the inspector so descendant
    // `MorePopover` panels reset to closed. Without this, the
    // popover on the previous row can stay open on the new one.
    const other = { ...addressable, origAddr: "10.0.0.6" };
    expect(quickPeekResetKey(addressable as never)).not.toBe(
      quickPeekResetKey(other as never),
    );
  });

  it("falls back to a composite identity for unencodable events", () => {
    // Schema-limited subtypes (e.g. `ExtraThreat`, or rows missing
    // both source and destination IP) have no locator token but
    // still open the Quick peek; the remount key must stay stable
    // for those rows and still differ from other unencodable rows.
    const extra = {
      __typename: "ExtraThreat" as const,
      sensor: "sensor-a",
      time: "2026-04-22T00:00:00.000Z",
      level: "LOW" as const,
    };
    const extraOther = { ...extra, time: "2026-04-22T00:00:01.000Z" };
    expect(quickPeekResetKey(extra as never)).toBe(
      quickPeekResetKey(extra as never),
    );
    expect(quickPeekResetKey(extra as never)).not.toBe(
      quickPeekResetKey(extraOther as never),
    );
  });
});

describe("shouldStripStaleQuickPeekToken", () => {
  let shouldStripStaleQuickPeekToken: ShellModule["shouldStripStaleQuickPeekToken"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    shouldStripStaleQuickPeekToken = mod.shouldStripStaleQuickPeekToken;
  });

  it("does not strip when there is no token to begin with", () => {
    expect(
      shouldStripStaleQuickPeekToken({
        tokenPresent: false,
        matchFound: false,
        initialErrored: false,
      }),
    ).toBe(false);
  });

  it("does not strip when the token matches an event in the slice", () => {
    expect(
      shouldStripStaleQuickPeekToken({
        tokenPresent: true,
        matchFound: true,
        initialErrored: false,
      }),
    ).toBe(false);
  });

  it("strips when a successful slice does not contain the token", () => {
    // The documented "close the peek silently" behavior: the slice
    // loaded successfully but did not include the selected event.
    expect(
      shouldStripStaleQuickPeekToken({
        tokenPresent: true,
        matchFound: false,
        initialErrored: false,
      }),
    ).toBe(true);
  });

  it("preserves the token when the initial fetch errored", () => {
    // Regression (Reviewer Round 6 #2): a transient backend error on
    // first load collapses the slice to `[]`, which would otherwise
    // look identical to a confirmed mismatch. Preserving the token
    // lets a subsequent successful reload restore the peek rather
    // than permanently discarding the selection URL state on a
    // single transient failure.
    expect(
      shouldStripStaleQuickPeekToken({
        tokenPresent: true,
        matchFound: false,
        initialErrored: true,
      }),
    ).toBe(false);
  });
});

describe("reconcileQuickPeekUrlAction", () => {
  let reconcileQuickPeekUrlAction: ShellModule["reconcileQuickPeekUrlAction"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    reconcileQuickPeekUrlAction = mod.reconcileQuickPeekUrlAction;
  });

  it("no-ops when the URL carries no token", () => {
    // Most Refresh calls land here: no pending restore means the
    // post-fetch reconcile has nothing to do.
    expect(
      reconcileQuickPeekUrlAction({ tokenPresent: false, matchFound: false }),
    ).toBe("noop");
  });

  it("restores the peek when a pending token matches a row in the fresh slice", () => {
    // Regression (Reviewer Round 7): the "reload with `?event=` ->
    // transient backend error -> Refresh -> retry succeeds" path.
    // The URL token was preserved through dispatch because no peek
    // was open at the time, and the successful retry now returns a
    // slice that contains the selected event. The reconcile pins
    // the peek so the operator's selection URL state survives.
    expect(
      reconcileQuickPeekUrlAction({ tokenPresent: true, matchFound: true }),
    ).toBe("restore");
  });

  it("strips the token when a successful slice confirms it stale", () => {
    // Regression (Reviewer Round 7): if the retry slice does not
    // contain the selected event, this is the first successful
    // slice that can prove the pending token stale — the mount
    // effect is gated on `[]` and only runs once, so without this
    // post-fetch hook the stale token would sit in the URL until
    // a manual reload.
    expect(
      reconcileQuickPeekUrlAction({ tokenPresent: true, matchFound: false }),
    ).toBe("strip");
  });
});

describe("shouldCloseQuickPeekOnEscape", () => {
  // Regression (Reviewer Round 13): a single Escape keypress used to
  // fire both the `MorePopover`'s own document-level Escape handler
  // and the shell's Quick peek Escape handler, collapsing the
  // popover and the inspector together. The shell's predicate now
  // skips the close whenever a popover is open, so the first Escape
  // unwinds only the topmost layer; the second Escape dismisses the
  // inspector.
  let shouldCloseQuickPeekOnEscape: ShellModule["shouldCloseQuickPeekOnEscape"];

  it("loads the helper", async () => {
    const mod = await import("@/components/detection/detection-shell");
    shouldCloseQuickPeekOnEscape = mod.shouldCloseQuickPeekOnEscape;
  });

  it("skips the close while any MorePopover is open", () => {
    expect(
      shouldCloseQuickPeekOnEscape({
        isDesktop: true,
        quickPeekOpen: true,
        morePopoverOpen: true,
      }),
    ).toBe(false);
  });

  it("closes the peek on Escape when no popover is open", () => {
    expect(
      shouldCloseQuickPeekOnEscape({
        isDesktop: true,
        quickPeekOpen: true,
        morePopoverOpen: false,
      }),
    ).toBe(true);
  });

  it("no-ops when the inspector itself is closed", () => {
    // Belt-and-braces: the shell only attaches the Escape listener
    // while `quickPeekEvent !== null`, but the predicate should
    // still report `false` if the listener were called with the
    // inspector already closed (e.g. after a state transition
    // between registration and dispatch).
    expect(
      shouldCloseQuickPeekOnEscape({
        isDesktop: true,
        quickPeekOpen: false,
        morePopoverOpen: false,
      }),
    ).toBe(false);
  });

  it("no-ops off the desktop branch", () => {
    // The narrow overlay Sheet has its own `onEscapeKeyDown` path;
    // the desktop inline Escape handler is not the right owner of
    // the close behaviour there.
    expect(
      shouldCloseQuickPeekOnEscape({
        isDesktop: false,
        quickPeekOpen: true,
        morePopoverOpen: false,
      }),
    ).toBe(false);
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
