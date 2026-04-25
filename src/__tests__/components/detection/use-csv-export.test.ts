import { describe, expect, it, vi } from "vitest";

import type { SaveTarget } from "@/components/detection/csv-download";
import type {
  CsvExportPayload,
  CsvExportStatus,
} from "@/components/detection/use-csv-export";

/**
 * Reviewer Round 10 locks down the ordering between the large-
 * export confirmation and the native save picker: known-large and
 * known-over-cap exports must gate on the client *before*
 * `showSaveFilePicker()` is called. Before this fix, Chromium
 * users on a filter above the threshold saw the save dialog first
 * and the row-count confirmation second; an export already known
 * to exceed `CSV_EXPORT_MAX_ROWS` still opened the picker even
 * though the server was going to reject it.
 *
 * The tests here assert on the observable effect — whether
 * `startSavePicker` is called during `start()` — because that is
 * the contract the operator sees. The hook is exercised with a
 * lightweight React-hooks stub (same pattern as
 * `use-session-monitor.test.ts`) so the test does not depend on
 * `@testing-library/react`, which this repo does not ship.
 */

// ── Test doubles for the transport primitives ──────

const startSavePickerMock = vi.fn();
const streamResponseToHandleMock = vi.fn();
const triggerBlobDownloadMock = vi.fn();

vi.mock("@/components/detection/csv-download", () => ({
  startSavePicker: (...args: unknown[]) => startSavePickerMock(...args),
  streamResponseToHandle: (...args: unknown[]) =>
    streamResponseToHandleMock(...args),
  triggerBlobDownload: (...args: unknown[]) => triggerBlobDownloadMock(...args),
}));

vi.mock("@/components/session/session-extension-dialog", () => ({
  readCsrfToken: () => "test-csrf",
}));

// ── React hook stub ────────────────────────────────

type StateEntry<T> = { value: T; setter: (v: T | ((p: T) => T)) => void };
const stateEntries: Array<StateEntry<unknown>> = [];

function resetStateEntries(initial: CsvExportStatus) {
  stateEntries.length = 0;
  const statusEntry: StateEntry<CsvExportStatus> = {
    value: initial,
    setter: (v) => {
      statusEntry.value =
        typeof v === "function"
          ? (v as (p: CsvExportStatus) => CsvExportStatus)(statusEntry.value)
          : v;
    },
  };
  stateEntries.push(statusEntry as StateEntry<unknown>);
  const pendingEntry: StateEntry<unknown> = {
    value: null,
    setter: (v) => {
      pendingEntry.value =
        typeof v === "function"
          ? (v as (p: unknown) => unknown)(pendingEntry.value)
          : v;
    },
  };
  stateEntries.push(pendingEntry);
}

// Per-render bookkeeping for `useRef` so the same ref object is
// returned on subsequent calls of the hook, mirroring React's own
// guarantee. The list is reset alongside `useState` ordering before
// each hook invocation in `loadHook`.
const refEntries: Array<{ current: unknown }> = [];
function resetRefEntries() {
  refEntries.length = 0;
}

vi.mock("react", () => {
  let stateIdx = 0;
  let refIdx = 0;
  return {
    useCallback: (fn: unknown) => fn,
    // Effects are fire-and-forget in this stub; the export hook only
    // uses `useEffect` for an unmount-cleanup that the tests do not
    // exercise. A no-op keeps the call site type-compatible without
    // dragging in React's effect scheduler.
    useEffect: (_fn: unknown, _deps?: unknown) => {},
    useRef: <T>(initial: T) => {
      const entry = refEntries[refIdx];
      if (entry) {
        refIdx += 1;
        return entry as { current: T };
      }
      const fresh: { current: T } = { current: initial };
      refEntries[refIdx++] = fresh as { current: unknown };
      return fresh;
    },
    useState: (initial: unknown) => {
      const entry = stateEntries[stateIdx++];
      if (!entry) {
        throw new Error("unexpected extra useState call");
      }
      // Honour lazy-initializer form even though the hook currently
      // passes plain values — defensive so future edits that add a
      // third useState do not silently drop the initial value.
      if (entry.value === undefined) {
        entry.value =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      }
      return [entry.value, entry.setter];
    },
    // Reset the indices between hook calls.
    __resetReact: () => {
      stateIdx = 0;
      refIdx = 0;
    },
  };
});

async function loadHook() {
  const mod = await import("@/components/detection/use-csv-export");
  const reactMod = (await import("react")) as unknown as {
    __resetReact: () => void;
  };
  reactMod.__resetReact();
  resetRefEntries();
  return mod.useCsvExport;
}

function makePayload(): CsvExportPayload {
  return {
    filter: {
      mode: "structured",
      input: { periodStart: null, periodEnd: null },
    } as CsvExportPayload["filter"],
    periodKey: "1h",
    headers: {
      level: "Level",
      time: "Time",
      kind: "Kind",
      attackKind: "Attack kind",
      category: "Category",
      confidence: "Confidence",
      triage: "Triage",
      source: "Source",
      destination: "Destination",
      sensor: "Sensor",
      userName: "User",
      hostname: "Host",
    },
    formatRowOptions: {
      levelLabels: {},
      categoryLabels: {},
      countryUnknown: "unknown",
      countryUnavailable: "unavailable",
      triageSummaryTemplate: "{count} · {max}",
      moreCountSuffixTemplate: "+{count} more",
    } as CsvExportPayload["formatRowOptions"],
  };
}

function setup() {
  startSavePickerMock.mockReset();
  streamResponseToHandleMock.mockReset();
  triggerBlobDownloadMock.mockReset();
  resetStateEntries({ kind: "idle" });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

describe("useCsvExport — Reviewer Round 10 local gating", () => {
  it("does not open the save picker when the known count is at or above the large-export threshold", async () => {
    const { fetchMock } = setup();
    const useCsvExport = await loadHook();
    const hook = useCsvExport({
      buildPayload: makePayload,
      errorMessage: "export failed",
      getKnownTotalCount: () => "150000",
    });

    hook.start();

    // Confirmation dialog must be raised *before* any native save
    // prompt — this is the exact ordering the reviewer flagged.
    expect(startSavePickerMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [statusEntry] = stateEntries as [StateEntry<CsvExportStatus>];
    expect(statusEntry.value.kind).toBe("confirm-required");
    if (statusEntry.value.kind === "confirm-required") {
      expect(statusEntry.value.confirmation.totalCount).toBe("150000");
      expect(statusEntry.value.confirmation.threshold).toBe(100_000);
    }
  });

  it("does not open the save picker when the known count exceeds the hard row cap", async () => {
    const { fetchMock } = setup();
    const useCsvExport = await loadHook();
    const hook = useCsvExport({
      buildPayload: makePayload,
      errorMessage: "export failed",
      formatLimitExceededMessage: ({ totalCount, limit }) =>
        `too big: ${totalCount}/${limit}`,
      getKnownTotalCount: () => "1500000",
    });

    hook.start();

    expect(startSavePickerMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [statusEntry] = stateEntries as [StateEntry<CsvExportStatus>];
    expect(statusEntry.value.kind).toBe("error");
    if (statusEntry.value.kind === "error") {
      expect(statusEntry.value.message).toBe("too big: 1500000/1000000");
    }
  });

  it("opens the save picker synchronously on Continue when the large-export gate deferred it", async () => {
    const { fetchMock } = setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
    startSavePickerMock.mockReturnValue(
      new Promise(() => {
        /* never resolves — we only care that the picker was invoked */
      }),
    );
    const useCsvExport = await loadHook();
    const options = {
      buildPayload: makePayload,
      errorMessage: "export failed",
      getKnownTotalCount: () => "150000",
    };
    const hook = useCsvExport(options);

    hook.start();
    expect(startSavePickerMock).not.toHaveBeenCalled();

    // Simulate a React re-render so `confirmAndContinue` sees the
    // pending-confirmation state that `start()` just wrote. Without
    // this, the captured `pendingConfirmation` closure value would
    // still be `null` and the Continue callback would early-return —
    // a quirk of the lightweight hooks stub, not of the production
    // component tree, where React always re-runs the hook after a
    // state transition.
    const reactMod = (await import("react")) as unknown as {
      __resetReact: () => void;
    };
    reactMod.__resetReact();
    const hookAfterConfirm = useCsvExport(options);
    hookAfterConfirm.confirmAndContinue();

    // Continue is a fresh user gesture — the picker must fire
    // synchronously on that click so transient activation is still
    // valid in Chromium.
    expect(startSavePickerMock).toHaveBeenCalledTimes(1);
    expect(startSavePickerMock.mock.calls[0][0]).toMatch(/\.csv$/);
  });

  it("opens the save picker on the initial click when the known count is below the threshold", async () => {
    setup();
    startSavePickerMock.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    // The preflight fetch never resolves either — we only assert on
    // the synchronous behaviour before any await.
    const { fetchMock } = setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
    startSavePickerMock.mockReturnValue(new Promise(() => {}));
    const useCsvExport = await loadHook();
    const hook = useCsvExport({
      buildPayload: makePayload,
      errorMessage: "export failed",
      getKnownTotalCount: () => "500",
    });

    hook.start();

    // Small known count → picker synchronously on initial click,
    // preserving transient activation for the `fetch()` await.
    expect(startSavePickerMock).toHaveBeenCalledTimes(1);
  });

  it("opens the save picker on the initial click when the known count is unavailable", async () => {
    const { fetchMock } = setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
    startSavePickerMock.mockReturnValue(new Promise(() => {}));
    const useCsvExport = await loadHook();
    const hook = useCsvExport({
      buildPayload: makePayload,
      errorMessage: "export failed",
      getKnownTotalCount: () => null,
    });

    hook.start();

    // Unknown count: we cannot gate locally, so the picker opens
    // synchronously and the server's 409 / 413 remains the backstop.
    expect(startSavePickerMock).toHaveBeenCalledTimes(1);
  });

  // Closing the Chromium Save-As picker, dismissing the large-export
  // confirmation dialog, or unmounting the export hook each abort the
  // in-flight fetch via the per-request AbortController. That abort
  // surfaces as a fetch rejection inside `runExport`'s try/catch — the
  // hook must distinguish "we cancelled this ourselves" from a real
  // network failure and silently return to `idle` so the operator does
  // not see a spurious error banner. Without this branch, every Cancel
  // flashed an "export failed" message even though the user had just
  // walked away. See `use-csv-export.ts` lines 281-291.
  it("returns to idle without surfacing an error when the in-flight fetch aborts", async () => {
    const { fetchMock } = setup();
    // First start the picker promise; then make fetch hang until the
    // controller fires, at which point it rejects with AbortError.
    startSavePickerMock.mockReturnValue(new Promise(() => {}));
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const useCsvExport = await loadHook();
    const options = {
      buildPayload: makePayload,
      errorMessage: "export failed",
      getKnownTotalCount: () => null,
    };
    const hook = useCsvExport(options);

    hook.start();
    // After the click the hook is in `running` while the fetch hangs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchInit = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(fetchInit.signal).toBeInstanceOf(AbortSignal);

    // Re-render so the latest hook closure observes the running state,
    // then dismiss the confirmation. This path calls `abortInFlight()`,
    // which fires the AbortController the running fetch is wired to.
    const reactMod = (await import("react")) as unknown as {
      __resetReact: () => void;
    };
    reactMod.__resetReact();
    const hookAfterRunning = useCsvExport(options);
    hookAfterRunning.cancelConfirmation();

    // Yield twice so runExport's catch block has time to observe the
    // AbortError and flip the status back to idle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [statusEntry] = stateEntries as [StateEntry<CsvExportStatus>];
    expect(statusEntry.value.kind).toBe("idle");
    expect(fetchInit.signal?.aborted).toBe(true);
  });

  // Reviewer Round 1 caught a real gap: dismissing the Chromium Save
  // As dialog while the preflight `fetch()` is still in-flight (e.g.
  // during the row-count probe or a slow initial REview round-trip)
  // did not abort the controller until *after* `await fetch()`
  // returned, because `resolveSaveOutcome()` was only consulted from
  // the response-handling branches. The hook now watches the save
  // picker as soon as the request is set up, so a cancelled picker
  // aborts the in-flight fetch promptly — matching the manual claim
  // that dismissing the Save As dialog forwards the abort signal all
  // the way into REview's in-flight `eventList` request.
  it("aborts the in-flight fetch promptly when the save picker is dismissed mid-fetch", async () => {
    const { fetchMock } = setup();

    let resolvePicker: (target: SaveTarget) => void = () => {};
    const pickerPromise = new Promise<SaveTarget>((resolve) => {
      resolvePicker = resolve;
    });
    startSavePickerMock.mockReturnValue(pickerPromise);

    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const useCsvExport = await loadHook();
    const hook = useCsvExport({
      buildPayload: makePayload,
      errorMessage: "export failed",
      // Unknown count → the picker opens synchronously on click and
      // `runExport` is invoked with a still-pending pickerPromise.
      getKnownTotalCount: () => null,
    });

    hook.start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchInit = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(fetchInit.signal).toBeInstanceOf(AbortSignal);
    expect(fetchInit.signal?.aborted).toBe(false);

    // Operator dismisses the Save As dialog while the preflight is
    // still pending (e.g. row-count probe + slow REview page).
    resolvePicker({ kind: "cancelled" });

    // Yield so the picker-watcher `.then` runs before we assert.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchInit.signal?.aborted).toBe(true);

    // Yield more so runExport's catch block can flip status to idle
    // after the AbortError surfaces from `await fetch()`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [statusEntry] = stateEntries as [StateEntry<CsvExportStatus>];
    expect(statusEntry.value.kind).toBe("idle");
  });
});
