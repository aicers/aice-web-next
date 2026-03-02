import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── localStorage mock ────────────────────────────

const storage = new Map<string, string>();

const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
  clear: vi.fn(() => storage.clear()),
};

vi.stubGlobal("localStorage", localStorageMock);

// ── React hooks mock ────────────────────────────

let stateValue = false;
const setStateFn = vi.fn((updater: boolean | ((prev: boolean) => boolean)) => {
  if (typeof updater === "function") {
    stateValue = updater(stateValue);
  } else {
    stateValue = updater;
  }
});

const useEffectCallbacks: Array<() => void> = [];

vi.mock("react", () => ({
  useState: (initial: boolean) => {
    stateValue = initial;
    return [stateValue, setStateFn] as const;
  },
  useCallback: (fn: () => void) => fn,
  useEffect: (cb: () => void) => {
    useEffectCallbacks.push(cb);
  },
}));

// ── Tests ────────────────────────────

describe("useSidebar", () => {
  beforeEach(() => {
    storage.clear();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    setStateFn.mockClear();
    stateValue = false;
    useEffectCallbacks.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns collapsed=false by default", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const result = useSidebar();

    expect(result.collapsed).toBe(false);
  });

  it("reads localStorage on mount via useEffect", async () => {
    storage.set("sidebar-collapsed", "true");
    const { useSidebar } = await import("@/hooks/use-sidebar");
    useSidebar();

    // Simulate useEffect running
    for (const cb of useEffectCallbacks) {
      cb();
    }

    expect(localStorageMock.getItem).toHaveBeenCalledWith("sidebar-collapsed");
    expect(setStateFn).toHaveBeenCalledWith(true);
  });

  it("does not set collapsed when localStorage has no value", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    useSidebar();

    for (const cb of useEffectCallbacks) {
      cb();
    }

    expect(localStorageMock.getItem).toHaveBeenCalledWith("sidebar-collapsed");
    // setStateFn should NOT have been called (only initial useState call)
    expect(setStateFn).not.toHaveBeenCalled();
  });

  it("toggle() flips collapsed and persists to localStorage", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    // stateValue starts as false, so toggle should set it to true
    toggle();

    expect(setStateFn).toHaveBeenCalledOnce();
    // The updater function was called: !false => true
    expect(stateValue).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "true",
    );
  });

  it("collapse() sets collapsed=true and persists", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { collapse } = useSidebar();

    collapse();

    expect(setStateFn).toHaveBeenCalledWith(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "true",
    );
  });

  it("expand() sets collapsed=false and persists", async () => {
    stateValue = true;
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { expand } = useSidebar();

    expand();

    expect(setStateFn).toHaveBeenCalledWith(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "false",
    );
  });

  it("toggle() twice returns to original state", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    toggle(); // false -> true
    expect(stateValue).toBe(true);

    toggle(); // true -> false
    expect(stateValue).toBe(false);

    expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
      "sidebar-collapsed",
      "false",
    );
  });

  it("uses 'sidebar-collapsed' as the storage key", async () => {
    storage.set("sidebar-collapsed", "true");
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    for (const cb of useEffectCallbacks) {
      cb();
    }

    toggle();

    expect(localStorageMock.getItem).toHaveBeenCalledWith("sidebar-collapsed");
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      expect.any(String),
    );
  });
});
