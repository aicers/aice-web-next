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
  const defaultTtl = 900;

  function makeSessionCookies(exp: number, ttl = defaultTtl): string {
    return `token_exp=${exp}; token_ttl=${ttl}`;
  }

  beforeEach(() => {
    fakeCookie = "";
    remainingState = 0;
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
    fakeCookie = makeSessionCookies(now + 600);
    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    const result = useSessionMonitor();

    expect(result.remainingSeconds).toBeGreaterThanOrEqual(599);
    expect(result.remainingSeconds).toBeLessThanOrEqual(600);
    expect(result.showDialog).toBe(false);
    expect(typeof result.dismiss).toBe("function");
  });

  it("does not show dialog when session monitor cookies are absent", async () => {
    fakeCookie = "";
    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(false);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("does not show dialog when remaining is above one-fifth of the TTL", async () => {
    const exp = now + 600; // 10 min remaining — well above threshold
    fakeCookie = makeSessionCookies(exp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(false);
  });

  it("shows dialog when remaining is below one-fifth of the TTL", async () => {
    const exp = now + 120; // 2 min remaining — below threshold
    fakeCookie = makeSessionCookies(exp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("shows dialog at exactly the one-fifth threshold boundary", async () => {
    const exp = now + defaultTtl / 5;
    fakeCookie = makeSessionCookies(exp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("redirects to sign-in when JWT is expired", async () => {
    const exp = now - 10; // expired 10 seconds ago
    fakeCookie = makeSessionCookies(exp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(mockRouterPush).toHaveBeenCalledWith(
      "/sign-in?reason=session-ended",
    );
    expect(setShowDialog).toHaveBeenCalledWith(false);
  });

  it("sets remainingSeconds to 0 when expired", async () => {
    const exp = now - 10;
    fakeCookie = makeSessionCookies(exp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setRemaining).toHaveBeenCalledWith(0);
  });

  it("dismiss() records the current exp and prevents re-show", async () => {
    const exp = now + 100;
    fakeCookie = makeSessionCookies(exp);

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
    fakeCookie = makeSessionCookies(oldExp);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    const { dismiss } = useSessionMonitor();

    // Dismiss for the old exp
    dismiss();
    expect(refObject.current).toBe(oldExp);

    // Simulate rotation: token_exp changes to a new value
    const newExp = now + 900;
    fakeCookie = makeSessionCookies(newExp);

    setShowDialog.mockClear();
    runEffect();

    // The dismissedExpRef should be cleared because exp changed
    expect(refObject.current).toBeNull();
  });

  it("handles invalid cookie values gracefully", async () => {
    fakeCookie = "token_exp=not-a-number; token_ttl=bad";

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    // Should behave like no cookie — no dialog, no redirect
    expect(setShowDialog).toHaveBeenCalledWith(false);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("reads token cookies from among multiple cookies", async () => {
    const exp = now + 60;
    fakeCookie = `other=value; token_exp=${exp}; token_ttl=${defaultTtl}; csrf=abc123`;

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    // 60s remaining < 180s threshold for a 15-minute token → dialog should show
    expect(setShowDialog).toHaveBeenCalledWith(true);
  });

  it("updates remainingSeconds to correct non-zero value", async () => {
    const remaining = 120;
    const exp = now + remaining;
    fakeCookie = makeSessionCookies(exp);

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
    fakeCookie = makeSessionCookies(now + 600);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();

    // Each useEffect callback should return a function (clearInterval)
    for (const cb of useEffectCallbacks) {
      const cleanup = cb();
      expect(typeof cleanup).toBe("function");
    }
  });

  it("uses the current token TTL instead of a fixed 180-second threshold", async () => {
    fakeCookie = makeSessionCookies(now + 125, 600);

    const { useSessionMonitor } = await import("@/hooks/use-session-monitor");
    useSessionMonitor();
    runEffect();

    expect(setShowDialog).toHaveBeenCalledWith(false);
  });
});
