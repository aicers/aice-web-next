/**
 * Behavioural coverage for {@link useDetectionReturnNav} (#668, #751).
 *
 * The hook backs the sidebar / mobile Detection link's click handler:
 * a plain left-click is intercepted and routed to the last Detection
 * URL stored for the current scope. #751 changed the return shape to
 * `{ onClick, isPending }` (navigation wrapped in `useTransition` for
 * pending feedback) and made the plain left-click ALWAYS intercept —
 * including the no-stored-URL / cross-scope cases, which now route to
 * the bare `/detection` so they get pending feedback too instead of
 * falling through to the default `<Link>` navigation. Modifier-clicks
 * still fall through.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
let fingerprint: string | null = "scope-a";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));
vi.mock("@/components/providers/scope-fingerprint-provider", () => ({
  useScopeFingerprint: () => fingerprint,
}));

const { useDetectionReturnNav } = await import(
  "@/hooks/use-detection-return-nav"
);
const { writeLastDetectionUrl } = await import(
  "@/lib/detection/last-detection-url"
);

function Harness() {
  const { onClick, isPending } = useDetectionReturnNav();
  return (
    <a href="/detection" onClick={onClick} data-pending={isPending}>
      Detection
    </a>
  );
}

describe("useDetectionReturnNav", () => {
  beforeEach(() => {
    pushMock.mockClear();
    fingerprint = "scope-a";
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("returns an onClick handler and a starting isPending of false", () => {
    render(<Harness />);
    const link = screen.getByText("Detection");
    expect(link.getAttribute("data-pending")).toBe("false");
  });

  it("intercepts a plain left-click and routes to the stored URL", () => {
    writeLastDetectionUrl("f=abc&tab=t1", "scope-a");
    render(<Harness />);
    const link = screen.getByText("Detection");
    const event = fireEvent.click(link, { button: 0 });
    expect(pushMock).toHaveBeenCalledWith("/detection?f=abc&tab=t1");
    // The default `<Link>` navigation is suppressed — the hook drives
    // the push itself so it can wrap it in the pending transition.
    expect(event).toBe(false);
  });

  it("intercepts the no-stored-URL path and routes to the bare /detection", () => {
    render(<Harness />);
    const link = screen.getByText("Detection");
    const event = fireEvent.click(link, { button: 0 });
    // #751: the bare-route path is now intercepted too (rather than
    // falling through to the default `<Link>`), so it gets the pending
    // transition wrapping `router.push`.
    expect(pushMock).toHaveBeenCalledWith("/detection");
    expect(event).toBe(false);
  });

  it("does not intercept a modifier (open-in-new-tab) click", () => {
    writeLastDetectionUrl("f=abc&tab=t1", "scope-a");
    render(<Harness />);
    fireEvent.click(screen.getByText("Detection"), {
      button: 0,
      metaKey: true,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not leak another scope's stored URL", () => {
    writeLastDetectionUrl("f=abc&tab=t1", "scope-a");
    fingerprint = "scope-b";
    render(<Harness />);
    fireEvent.click(screen.getByText("Detection"), { button: 0 });
    // scope-b has nothing stored, so it routes to the bare route — the
    // scope-a filter never leaks across the scope boundary.
    expect(pushMock).toHaveBeenCalledWith("/detection");
    expect(pushMock).not.toHaveBeenCalledWith("/detection?f=abc&tab=t1");
  });
});
