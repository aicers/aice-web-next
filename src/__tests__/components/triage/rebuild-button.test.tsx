/**
 * UI coverage for {@link TriageRebuildButton} — the admin-only
 * affordance that drives the destructive `DELETE` + reinsert path of
 * #473. The server routes are independently covered; this file pins
 * the user-facing rules the issue calls out explicitly:
 *
 *   - the single-customer scope gate (button vs. disabled-tooltip
 *     affordance vs. no resolved customer);
 *   - the confirm modal's estimate / warning rendering;
 *   - the distinct toast text for the three known failure codes
 *     (`RebuildBusy` / `RebuildTimeout` / `RebuildIncomplete`) so a
 *     regression in the typed-code branching does not collapse them
 *     into a single message;
 *   - the in-flight `onSubmittingChange` signal the shell uses to
 *     render the row-list overlay.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TriageRebuildButton,
  type TriageRebuildLabels,
} from "@/components/triage/rebuild-button";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefresh,
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("@/lib/csrf-client", () => ({
  readCsrfToken: () => "test-csrf",
}));

const LABELS: TriageRebuildLabels = {
  button: "Rebuild this period",
  multiScopeTooltip: "Switch to a single-customer scope",
  modalTitle: "Confirm rebuild",
  modalIntro: "This is destructive.",
  customerLabel: "Customer",
  periodLabel: "Period",
  whatThisDoesLabel: "What this does",
  whatThisDoesBody: "Re-fetch and rebuild the corpus.",
  estimateLabel: "Estimated rows",
  estimateHint: "rows",
  abortNote: "Keep this tab open.",
  confirmButton: "Confirm",
  cancelButton: "Cancel",
  toastSuccessTemplate: "Rebuilt: deleted {deleted}, inserted {inserted}",
  toastBusy: "cadence holds the lock",
  toastTimeout: "rebuild timed out",
  toastIncomplete: "paginator did not finish",
  toastErrorPrefix: "Rebuild failed:",
  rebuildingOverlay: "Rebuilding this period…",
};

const PERIOD = {
  startIso: "2026-05-08T00:00:00.000Z",
  endIso: "2026-05-09T00:00:00.000Z",
};

const CUSTOMER = { id: 42, name: "Acme Corp" };

async function flushAsync(cycles = 6) {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  routerRefresh.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TriageRebuildButton — scope gate", () => {
  it("renders the disabled-tooltip affordance when the scope has 2+ customers", () => {
    render(
      <TriageRebuildButton
        customer={CUSTOMER}
        multiCustomerScope
        period={PERIOD}
        labels={LABELS}
      />,
    );
    const btn = screen.getByRole("button", { name: LABELS.multiScopeTooltip });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // The label text still surfaces on the button face so the operator
    // sees the affordance the gate is hiding.
    expect(btn.textContent).toContain(LABELS.button);
    // Clicking the disabled affordance must not call fetch.
    fireEvent.click(btn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the disabled-tooltip affordance when no customer can be resolved", () => {
    // The shell passes `customer = null` when an effective scope of 1
    // still cannot resolve a name. Treated the same as multi-scope so
    // the rebuild cannot fire without a named tenant on the modal.
    render(
      <TriageRebuildButton
        customer={null}
        multiCustomerScope={false}
        period={PERIOD}
        labels={LABELS}
      />,
    );
    const btn = screen.getByRole("button", { name: LABELS.multiScopeTooltip });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the active button when the scope has exactly one customer", () => {
    render(
      <TriageRebuildButton
        customer={CUSTOMER}
        multiCustomerScope={false}
        period={PERIOD}
        labels={LABELS}
      />,
    );
    const btn = screen.getByRole("button", { name: LABELS.button });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("TriageRebuildButton — confirm modal", () => {
  it("opens the modal and renders the estimate + retention warning from the GET response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        currentTriagedRowCount: 123,
        warnings: ["this period may predate the detector store's data"],
      }),
    );
    render(
      <TriageRebuildButton
        customer={CUSTOMER}
        multiCustomerScope={false}
        period={PERIOD}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: LABELS.button }));
    await flushAsync();

    const dialog = screen.getByRole("alertdialog", {
      name: LABELS.modalTitle,
    });
    const text = dialog.textContent ?? "";
    expect(text).toContain("Acme Corp");
    expect(text).toContain("#42");
    expect(text).toContain("123");
    expect(text).toContain("this period may predate the detector store's data");
    expect(text).toContain(LABELS.abortNote);

    // Confirm is enabled only once the estimate resolves.
    const confirm = screen.getByRole("button", {
      name: LABELS.confirmButton,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    // The estimate fetch must hit the GET endpoint with the same
    // `[from, to)` window the POST will use.
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/triage/baseline/rebuild/estimate");
    expect(url.searchParams.get("customerId")).toBe("42");
    expect(url.searchParams.get("from")).toBe(PERIOD.startIso);
    expect(url.searchParams.get("to")).toBe(PERIOD.endIso);
  });

  it("keeps the Confirm button disabled while the estimate is still loading", () => {
    // Resolve the estimate fetch only after we have inspected the
    // disabled state — the modal opens synchronously on click but the
    // Confirm must wait for `estimate.status === "ready"`.
    let resolveEstimate: ((value: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolveEstimate = r;
      }),
    );
    render(
      <TriageRebuildButton
        customer={CUSTOMER}
        multiCustomerScope={false}
        period={PERIOD}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: LABELS.button }));
    const confirm = screen.getByRole("button", {
      name: LABELS.confirmButton,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    resolveEstimate?.(
      jsonResponse(200, { currentTriagedRowCount: 0, warnings: [] }),
    );
  });
});

describe("TriageRebuildButton — confirm + POST outcomes", () => {
  async function openAndConfirm(
    onSubmittingChange?: (submitting: boolean) => void,
  ) {
    render(
      <TriageRebuildButton
        customer={CUSTOMER}
        multiCustomerScope={false}
        period={PERIOD}
        labels={LABELS}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: LABELS.button }));
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: LABELS.confirmButton }));
    await flushAsync();
  }

  it("renders the success toast with the exact deleted / inserted counts and refreshes the route", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          deletedTriagedRows: 9,
          insertedTriagedRows: 7,
        }),
      );
    const onSubmittingChange = vi.fn();
    await openAndConfirm(onSubmittingChange);

    expect(screen.getByRole("status").textContent).toContain(
      "Rebuilt: deleted 9, inserted 7",
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    // The submitting signal must flip true → false so the shell's
    // overlay clears cleanly after success.
    expect(onSubmittingChange).toHaveBeenNthCalledWith(1, true);
    expect(onSubmittingChange).toHaveBeenLastCalledWith(false);
  });

  it("maps HTTP 409 to the busy toast", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, { code: "RebuildBusy", error: "lock held" }),
      );
    await openAndConfirm();
    expect(screen.getByRole("status").textContent).toContain(LABELS.toastBusy);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("maps HTTP 504 + RebuildTimeout to the timeout toast", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(504, { code: "RebuildTimeout", error: "cap exceeded" }),
      );
    await openAndConfirm();
    expect(screen.getByRole("status").textContent).toContain(
      LABELS.toastTimeout,
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      LABELS.toastIncomplete,
    );
  });

  it("maps HTTP 504 + RebuildIncomplete to the distinct incomplete toast", async () => {
    // Branching on the typed `code` field is the contract the route
    // handler ships: two 504s carry different operator next-steps
    // (split-and-retry vs. investigate paginator), so the UI must NOT
    // collapse them into a single "timed out" message.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(504, {
          code: "RebuildIncomplete",
          error: "paginator not exhausted",
          pagesFetched: 10000,
        }),
      );
    await openAndConfirm();
    expect(screen.getByRole("status").textContent).toContain(
      LABELS.toastIncomplete,
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      LABELS.toastTimeout,
    );
  });

  it("renders the generic-error toast prefix on other HTTP errors", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(400, { code: "RebuildValidation", error: "bad customer" }),
      );
    await openAndConfirm();
    expect(screen.getByRole("status").textContent).toContain(
      "Rebuild failed: bad customer",
    );
  });

  it("re-enables the trigger button after the toast surfaces (submitting → false)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, { code: "RebuildBusy", error: "lock held" }),
      );
    await openAndConfirm();
    // The trigger button face flips back from the ellipsis to the
    // label so the operator can retry without reloading the page.
    const trigger = screen.getByRole("button", {
      name: LABELS.button,
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
  });

  it("sends the CSRF header and JSON body on the POST", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { currentTriagedRowCount: 5, warnings: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { deletedTriagedRows: 0, insertedTriagedRows: 0 }),
      );
    await openAndConfirm();
    const postCall = fetchMock.mock.calls[1];
    expect(postCall?.[0]).toBe("/api/triage/baseline/rebuild");
    const init = postCall?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "test-csrf",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 42,
      from: PERIOD.startIso,
      to: PERIOD.endIso,
    });
  });
});
