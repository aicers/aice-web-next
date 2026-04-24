import { describe, expect, it, vi } from "vitest";

import {
  createCloseSuppressor,
  createDialogCloseHandlers,
  formatByteSize,
} from "@/components/detection/csv-export-dialog";

describe("createCloseSuppressor", () => {
  it("consumes once after being armed, then falls back to default", () => {
    // The suppressor gates the one `onOpenChange(false)` Radix fires
    // when the operator clicks the Continue or Narrow action inside
    // the confirm dialog. Without it, that close would drive the
    // generic cancel path, clear the pending payload, and re-enable
    // the header button while the confirmed export was still in
    // flight — letting a second click trigger a duplicate export.
    const suppressor = createCloseSuppressor();
    expect(suppressor.consume()).toBe(false);
    suppressor.arm();
    expect(suppressor.consume()).toBe(true);
    // After consumption the latch is back to inert; a subsequent
    // close (Escape, overlay click, Cancel button) must fall
    // through to the cancel branch instead of being swallowed.
    expect(suppressor.consume()).toBe(false);
  });

  it("is idempotent under repeated arming", () => {
    const suppressor = createCloseSuppressor();
    suppressor.arm();
    suppressor.arm();
    // A second arm before a consume still only swallows one close.
    expect(suppressor.consume()).toBe(true);
    expect(suppressor.consume()).toBe(false);
  });
});

describe("createDialogCloseHandlers", () => {
  // These tests exercise the exact helper `CsvExportConfirmDialog`
  // imports and wires into Radix — the component holds a ref of
  // `createDialogCloseHandlers(...)` and passes
  // `handleContinue` / `handleNarrow` / `handleOpenChange` straight
  // to the respective props. Importing the same helper here means a
  // regression that forgets to arm the suppressor on Continue /
  // Narrow (or reintroduces an explicit cancel-click path) would
  // also fail these tests, since the component cannot opt out of
  // the helper without a visible diff. The previous test wrote its
  // own copy of the wiring, which is why Round 6 flagged it as weak
  // regression coverage.
  function makeHandlers() {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    const onNarrow = vi.fn();
    const handlers = createDialogCloseHandlers({
      onContinue,
      onCancel,
      onNarrow,
    });
    return {
      onContinue,
      onCancel,
      onNarrow,
      ...handlers,
    };
  }

  it("does not run onCancel when Continue closes the dialog", () => {
    const h = makeHandlers();
    h.handleContinue();
    // Radix fires onOpenChange(false) right after the action's
    // onClick — the suppressor must eat this close so the hook's
    // pending payload / running status are preserved.
    h.handleOpenChange(false);
    expect(h.onContinue).toHaveBeenCalledTimes(1);
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("runs onCancel for Escape / overlay / Cancel-button closes", () => {
    const h = makeHandlers();
    h.handleOpenChange(false);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not run onCancel when Narrow fires, since onNarrow already clears state", () => {
    // The Narrow handler in detection-shell already calls
    // `cancelConfirmation()` before opening the filter drawer; if
    // onOpenChange also drove onCancel we would flip the hook to
    // `idle` twice, which is harmless but noisy. Suppress.
    const h = makeHandlers();
    h.handleNarrow();
    h.handleOpenChange(false);
    expect(h.onNarrow).toHaveBeenCalledTimes(1);
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("arms the latch only for the immediately following close", () => {
    // After a Continue + close pair, a genuinely cancel-driven
    // close (e.g. the operator reopens the dialog on a subsequent
    // export and then presses Escape) must still route to onCancel.
    const h = makeHandlers();
    h.handleContinue();
    h.handleOpenChange(false);
    h.handleOpenChange(false); // simulated Escape on a fresh open
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores open=true transitions so only close paths are routed", () => {
    const h = makeHandlers();
    h.handleOpenChange(true);
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("picks up callbacks swapped in via update()", () => {
    // The component calls `update()` on every render so the
    // handlers always close over the latest prop callbacks without
    // resetting the suppressor's armed state. Confirm the swap is
    // visible and the arm/consume cycle still bridges Continue →
    // next close.
    const onContinue1 = vi.fn();
    const onCancel1 = vi.fn();
    const onNarrow1 = vi.fn();
    const handlers = createDialogCloseHandlers({
      onContinue: onContinue1,
      onCancel: onCancel1,
      onNarrow: onNarrow1,
    });
    handlers.handleContinue();
    expect(onContinue1).toHaveBeenCalledTimes(1);
    const onContinue2 = vi.fn();
    const onCancel2 = vi.fn();
    const onNarrow2 = vi.fn();
    handlers.update({
      onContinue: onContinue2,
      onCancel: onCancel2,
      onNarrow: onNarrow2,
    });
    // The close that Radix fires for the prior Continue must still
    // be swallowed — the suppressor state survives the prop swap.
    handlers.handleOpenChange(false);
    expect(onCancel2).not.toHaveBeenCalled();
    // A subsequent Escape / overlay close now routes to the fresh
    // cancel callback, never the stale one.
    handlers.handleOpenChange(false);
    expect(onCancel1).not.toHaveBeenCalled();
    expect(onCancel2).toHaveBeenCalledTimes(1);
    // And Narrow routes through the fresh callback too.
    handlers.handleNarrow();
    expect(onNarrow1).not.toHaveBeenCalled();
    expect(onNarrow2).toHaveBeenCalledTimes(1);
  });
});

describe("formatByteSize", () => {
  it("renders bytes, KiB, MiB, GiB with reasonable precision", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.00 KiB");
    expect(formatByteSize(1024 * 1024 * 5)).toBe("5.00 MiB");
    expect(formatByteSize(1024 * 1024 * 1024 * 3.5)).toBe("3.50 GiB");
  });
});
