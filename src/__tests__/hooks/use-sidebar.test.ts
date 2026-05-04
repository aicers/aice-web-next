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

// ── document.cookie mock ────────────────────────────

const cookieWrites: string[] = [];
let cookieJar = "";

vi.stubGlobal("document", {
  get cookie() {
    return cookieJar;
  },
  set cookie(value: string) {
    cookieWrites.push(value);
    const [pair] = value.split(";");
    const [name, val] = pair.split("=");
    const trimmedName = name?.trim();
    if (trimmedName) {
      const filtered = cookieJar
        .split("; ")
        .filter((c) => c && !c.startsWith(`${trimmedName}=`));
      filtered.push(`${trimmedName}=${val ?? ""}`);
      cookieJar = filtered.join("; ");
    }
  },
});

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
    cookieWrites.length = 0;
    cookieJar = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns collapsed=false by default for first-time users", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const result = useSidebar();

    expect(result.collapsed).toBe(false);
  });

  it("uses initialCollapsed when provided", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const result = useSidebar({ initialCollapsed: true, hasCookie: true });

    expect(result.collapsed).toBe(true);
  });

  it("falls back to localStorage when cookie is missing (legacy users)", async () => {
    storage.set("sidebar-collapsed", "true");
    const { useSidebar } = await import("@/hooks/use-sidebar");
    useSidebar({ initialCollapsed: false, hasCookie: false });

    for (const cb of useEffectCallbacks) {
      cb();
    }

    expect(localStorageMock.getItem).toHaveBeenCalledWith("sidebar-collapsed");
    expect(setStateFn).toHaveBeenCalledWith(true);
  });

  it("ignores localStorage when cookie is present (cookie wins)", async () => {
    storage.set("sidebar-collapsed", "true");
    const { useSidebar } = await import("@/hooks/use-sidebar");
    // Cookie present-and-false beats localStorage=true.
    useSidebar({ initialCollapsed: false, hasCookie: true });

    for (const cb of useEffectCallbacks) {
      cb();
    }

    expect(localStorageMock.getItem).not.toHaveBeenCalled();
    expect(setStateFn).not.toHaveBeenCalled();
  });

  it("does not set collapsed when localStorage has no value and no cookie", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    useSidebar();

    for (const cb of useEffectCallbacks) {
      cb();
    }

    expect(localStorageMock.getItem).toHaveBeenCalledWith("sidebar-collapsed");
    expect(setStateFn).not.toHaveBeenCalled();
  });

  it("toggle() flips collapsed and persists to both localStorage and cookie", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    toggle();

    expect(stateValue).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "true",
    );
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=true; path=\/;/);
    expect(cookieWrites[0]).toContain("max-age=");
  });

  it("collapse() sets collapsed=true and persists to both stores", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { collapse } = useSidebar();

    collapse();

    expect(setStateFn).toHaveBeenCalledWith(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "true",
    );
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=true;/);
  });

  it("expand() sets collapsed=false and persists to both stores", async () => {
    stateValue = true;
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { expand } = useSidebar({ initialCollapsed: true, hasCookie: true });

    expand();

    expect(setStateFn).toHaveBeenCalledWith(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "false",
    );
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=false;/);
  });

  it("toggle() twice returns to original state and rewrites both stores", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    toggle();
    expect(stateValue).toBe(true);

    toggle();
    expect(stateValue).toBe(false);

    expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
      "sidebar-collapsed",
      "false",
    );
    expect(cookieWrites.at(-1)).toMatch(/^sidebar-collapsed=false;/);
  });

  it("toggle realigns localStorage to match the new value", async () => {
    // Operator with stale localStorage=true but cookie present-and-false.
    storage.set("sidebar-collapsed", "true");
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar({
      initialCollapsed: false,
      hasCookie: true,
    });

    toggle();

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sidebar-collapsed",
      "true",
    );
  });
});
