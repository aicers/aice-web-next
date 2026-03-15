import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── document.cookie mock ─────────────────────────

let fakeCookie = "";

vi.stubGlobal("document", {
  get cookie() {
    return fakeCookie;
  },
  set cookie(val: string) {
    fakeCookie = val;
  },
});

// ── React hooks mock ─────────────────────────────

let remainingState = 181;
const setRemaining = vi.fn((v: number | ((p: number) => number)) => {
  remainingState = typeof v === "function" ? v(remainingState) : v;
});

let showDialogState = false;
const setShowDialog = vi.fn((v: boolean | ((p: boolean) => boolean)) => {
  showDialogState = typeof v === "function" ? v(showDialogState) : v;
});

const refObject = { current: null as number | null };

const useEffectCallbacks: Array<() => (() => void) | undefined> = [];

const mockRouterPush = vi.fn();

vi.mock("react", () => {
  let stateCallIndex = 0;
  return {
    useState: (initial: unknown) => {
      const idx = stateCallIndex++;
      // Support lazy initializer (function) form
      const resolved =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
      if (idx % 2 === 0) {
        // First useState = remainingSeconds
        remainingState = resolved as number;
        return [remainingState, setRemaining] as const;
      }
      // Second useState = showDialog
      showDialogState = resolved as boolean;
      return [showDialogState, setShowDialog] as const;
    },
    useRef: (initial: unknown) => {
      refObject.current = initial as number | null;
      return refObject;
    },
    useCallback: (fn: (...args: unknown[]) => unknown) => fn,
    useEffect: (cb: () => (() => void) | undefined) => {
      useEffectCallbacks.push(cb);
    },
  };
});

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

// ── Tests ────────────────────────────────────────

describe("useSessionMonitor", () => {
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    fakeCookie = "";
    remainingState = 181;
    showDialogState = false;
    refObject.current = null;
    useEffectCallbacks.length = 0;
    mockRouterPush.mockClear();
    setRemaining.mockClear();
    setShowDialog.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runEffect() {
    for (const cb of useEffectCallbacks) {
      cb();
    }
  }

  it("returns initial state with full remaining time", async () => {
    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    const result = useSessionMonitor();

    expect(result.remainingSeconds).toBe(181);
    expect(result.showDialog).toBe(false);
    expect(typeof result.dismiss).toBe("function");
  });

  it("does not show dialog when no token_exp cookie is present", async () => {
    fakeCookie = "";
    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(false);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("does not show dialog when remaining > threshold (180s)", async () => {
    const exp = now + 600; // 10 min remaining — well above threshold
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(false);
  });

  it("shows dialog when remaining ≤ threshold (180s)", async () => {
    const exp = now + 120; // 2 min remaining — below threshold
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("shows dialog at exactly the threshold boundary", async () => {
    const exp = now + 180; // exactly 3 min = 180s = threshold
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("redirects to sign-in when JWT is expired", async () => {
    const exp = now - 10; // expired 10 seconds ago
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(mockRouterPush).toHaveBeenCalledWith("/sign-in");
    expect(setShowDialog).toHaveBeenCalledWith(false);
  });

  it("sets remainingSeconds to 0 when expired", async () => {
    const exp = now - 10;
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setRemaining).toHaveBeenCalledWith(0);
  });

  it("dismiss() records the current exp and prevents re-show", async () => {
    const exp = now + 100;
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    const { dismiss } = useSessionMonitor();

    // Dismiss records current exp in ref
    dismiss();
    expect(refObject.current).toBe(exp);
    expect(setShowDialog).toHaveBeenCalledWith(false);

    // Next tick: same exp → should not show dialog because dismissed
    setShowDialog.mockClear();
    runEffect();

    // After dismiss, showDialog set to false (dismissed for this exp)
    expect(setShowDialog).toHaveBeenCalledWith(false);
  });

  it("clears dismissed state when token_exp changes (rotation)", async () => {
    const oldExp = now + 100;
    fakeCookie = `token_exp=${oldExp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    const { dismiss } = useSessionMonitor();

    // Dismiss for the old exp
    dismiss();
    expect(refObject.current).toBe(oldExp);

    // Simulate rotation: token_exp changes to a new value
    const newExp = now + 900;
    fakeCookie = `token_exp=${newExp}`;

    setShowDialog.mockClear();
    runEffect();

    // The dismissedExpRef should be cleared because exp changed
    expect(refObject.current).toBeNull();
  });

  it("handles non-numeric cookie values gracefully", async () => {
    fakeCookie = "token_exp=not-a-number";

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    // Should behave like no cookie — no dialog, no redirect
    expect(setShowDialog).toHaveBeenCalledWith(false);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("reads token_exp from among multiple cookies", async () => {
    const exp = now + 60;
    fakeCookie = `other=value; token_exp=${exp}; csrf=abc123`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    // 60s remaining < 180s threshold → dialog should show
    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("updates remainingSeconds to correct non-zero value", async () => {
    const remaining = 120;
    const exp = now + remaining;
    fakeCookie = `token_exp=${exp}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    // setRemaining should be called with approximately 120
    // (allow ±1s for timing)
    const call = setRemaining.mock.calls.find(
      (c: [number | ((p: number) => number)]) => {
        const v = c[0];
        return typeof v === "number" && v >= remaining - 1 && v <= remaining;
      },
    );
    expect(call).toBeDefined();
  });

  it("useEffect returns a cleanup function", async () => {
    fakeCookie = `token_exp=${now + 600}`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();

    // Each useEffect callback should return a function (clearInterval)
    for (const cb of useEffectCallbacks) {
      const cleanup = cb();
      expect(typeof cleanup).toBe("function");
    }
  });
});
