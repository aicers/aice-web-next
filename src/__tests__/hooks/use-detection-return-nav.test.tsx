/**
 * Behavioural coverage for {@link useDetectionReturnNav} (#668).
 *
 * The hook backs the sidebar / mobile Detection link's click handler:
 * a plain left-click is intercepted and routed to the last Detection
 * URL stored for the current scope, while modifier-clicks and the
 * "nothing stored" / cross-scope cases fall through to the bare
 * `/detection` href.
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
  const onClick = useDetectionReturnNav();
  return (
    <a href="/detection" onClick={onClick}>
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

  it("intercepts a plain left-click and routes to the stored URL", () => {
    writeLastDetectionUrl("f=abc&tab=t1", "scope-a");
    render(<Harness />);
    fireEvent.click(screen.getByText("Detection"), { button: 0 });
    expect(pushMock).toHaveBeenCalledWith("/detection?f=abc&tab=t1");
  });

  it("falls through to the bare href when nothing is stored", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Detection"), { button: 0 });
    expect(pushMock).not.toHaveBeenCalled();
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
    expect(pushMock).not.toHaveBeenCalled();
  });
});
