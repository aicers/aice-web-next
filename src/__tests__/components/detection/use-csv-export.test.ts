import { describe, expect, it, vi } from "vitest";

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

vi.mock("react", () => {
  let idx = 0;
  return {
    useCallback: (fn: unknown) => fn,
    useState: (initial: unknown) => {
      const entry = stateEntries[idx++];
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
    // Reset the idx between hook calls.
    __resetReact: () => {
      idx = 0;
    },
  };
});

async function loadHook() {
  const mod = await import("@/components/detection/use-csv-export");
  const reactMod = (await import("react")) as unknown as {
    __resetReact: () => void;
  };
  reactMod.__resetReact();
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
    setup();
    startSavePickerMock.mockReturnValue(
      new Promise(() => {
        /* never resolves — we only care that the picker was invoked */
      }),
    );
    const { fetchMock } = setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
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
});
