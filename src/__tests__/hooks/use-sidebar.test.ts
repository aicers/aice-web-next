import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("react", () => ({
  useState: (initial: boolean) => {
    stateValue = initial;
    return [stateValue, setStateFn] as const;
  },
  useCallback: (fn: () => void) => fn,
}));

// ── Tests ────────────────────────────

describe("useSidebar", () => {
  beforeEach(() => {
    setStateFn.mockClear();
    stateValue = false;
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
    const result = useSidebar({ initialCollapsed: true });

    expect(result.collapsed).toBe(true);
  });

  it("toggle() flips collapsed and persists to the cookie", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    toggle();

    expect(stateValue).toBe(true);
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=true; path=\/;/);
    expect(cookieWrites[0]).toContain("max-age=");
  });

  it("collapse() sets collapsed=true and persists to the cookie", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { collapse } = useSidebar();

    collapse();

    expect(setStateFn).toHaveBeenCalledWith(true);
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=true;/);
  });

  it("expand() sets collapsed=false and persists to the cookie", async () => {
    stateValue = true;
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { expand } = useSidebar({ initialCollapsed: true });

    expand();

    expect(setStateFn).toHaveBeenCalledWith(false);
    expect(cookieWrites[0]).toMatch(/^sidebar-collapsed=false;/);
  });

  it("toggle() twice returns to original state and rewrites the cookie", async () => {
    const { useSidebar } = await import("@/hooks/use-sidebar");
    const { toggle } = useSidebar();

    toggle();
    expect(stateValue).toBe(true);

    toggle();
    expect(stateValue).toBe(false);

    expect(cookieWrites.at(-1)).toMatch(/^sidebar-collapsed=false;/);
  });
});
