import { describe, expect, it, vi } from "vitest";

// Mock "use client" modules so we can import the pure helpers without
// pulling in React / Next.js runtime.
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useState: (v: unknown) => [v, vi.fn()],
  useEffect: vi.fn(),
  useRef: (v: unknown) => ({ current: v }),
}));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-session-monitor", () => ({
  useSessionMonitor: () => ({
    remainingSeconds: 120,
    showDialog: false,
    dismiss: vi.fn(),
  }),
}));
vi.mock("lucide-react", () => ({ Loader2: "div" }));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: "div",
  AlertDialogAction: "button",
  AlertDialogCancel: "button",
  AlertDialogContent: "div",
  AlertDialogDescription: "div",
  AlertDialogFooter: "div",
  AlertDialogHeader: "div",
  AlertDialogTitle: "div",
}));

// ── formatCountdown ─────────────────────────────────

describe("formatCountdown", () => {
  let formatCountdown: (s: number) => string;

  it("loads module", async () => {
    const mod = await import("@/components/session/session-extension-dialog");
    formatCountdown = mod.formatCountdown;
  });

  it("formats 0 seconds as 00:00", () => {
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("formats 59 seconds as 00:59", () => {
    expect(formatCountdown(59)).toBe("00:59");
  });

  it("formats 60 seconds as 01:00", () => {
    expect(formatCountdown(60)).toBe("01:00");
  });

  it("formats 90 seconds as 01:30", () => {
    expect(formatCountdown(90)).toBe("01:30");
  });

  it("formats 180 seconds as 03:00", () => {
    expect(formatCountdown(180)).toBe("03:00");
  });

  it("formats 599 seconds as 09:59", () => {
    expect(formatCountdown(599)).toBe("09:59");
  });

  it("formats 900 seconds as 15:00", () => {
    expect(formatCountdown(900)).toBe("15:00");
  });
});

// ── readCsrfToken ───────────────────────────────────

describe("readCsrfToken", () => {
  let readCsrfToken: () => string | null;

  let fakeCookie = "";
  vi.stubGlobal("document", {
    get cookie() {
      return fakeCookie;
    },
    set cookie(val: string) {
      fakeCookie = val;
    },
  });

  it("loads module", async () => {
    const mod = await import("@/components/session/session-extension-dialog");
    readCsrfToken = mod.readCsrfToken;
  });

  it("returns null when no CSRF cookie exists", () => {
    fakeCookie = "";
    expect(readCsrfToken()).toBeNull();
  });

  it("returns null when only unrelated cookies exist", () => {
    fakeCookie = "token_exp=12345; other=value";
    expect(readCsrfToken()).toBeNull();
  });

  it("reads csrf cookie (development)", () => {
    fakeCookie = "csrf=dev-token-123";
    expect(readCsrfToken()).toBe("dev-token-123");
  });

  it("reads __Host-csrf cookie (production)", () => {
    fakeCookie = "__Host-csrf=prod-token-456";
    expect(readCsrfToken()).toBe("prod-token-456");
  });

  it("prefers __Host-csrf over csrf when both present", () => {
    fakeCookie = "__Host-csrf=prod; csrf=dev";
    expect(readCsrfToken()).toBe("prod");
  });

  it("reads csrf from among multiple cookies", () => {
    fakeCookie = "token_exp=999; csrf=my-token; other=abc";
    expect(readCsrfToken()).toBe("my-token");
  });
});
