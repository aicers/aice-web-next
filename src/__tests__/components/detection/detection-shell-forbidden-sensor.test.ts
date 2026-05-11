import { describe, expect, it, vi } from "vitest";

// Same React / runtime mock pattern as `detection-shell-apply.test.ts`
// so we can import the pure helper without pulling the full client
// component's renderer into the test.
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: vi.fn(),
  useId: () => "t",
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
  startTransition: (fn: () => void) => fn(),
  createContext: (defaultValue: unknown) => ({
    Provider: "div",
    Consumer: "div",
    displayName: "MockedContext",
    _currentValue: defaultValue,
  }),
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => () => "",
  useLocale: () => "en",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/detection",
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("lucide-react", () => ({
  Bookmark: "span",
  ChevronRight: "span",
  ChevronDown: "span",
  SlidersHorizontal: "span",
  Star: "span",
  X: "span",
  XIcon: "span",
  RefreshCw: "span",
}));
vi.mock("@/app/[locale]/(dashboard)/detection/actions", () => ({
  runEventQuery: vi.fn(),
}));
vi.mock("@/app/[locale]/(dashboard)/detection/sensor-actions", () => ({
  fetchSensors: vi.fn(),
}));
vi.mock("@/components/ui/badge", () => ({ Badge: "span" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: "div",
  SheetContent: "div",
  SheetDescription: "div",
  SheetHeader: "div",
  SheetTitle: "div",
}));
vi.mock("@/components/detection/filter-drawer", () => ({
  FilterDrawer: "div",
}));
vi.mock("@/components/detection/sensor-multi-select", () => ({}));
vi.mock("@/components/detection/result-list", () => ({
  ResultList: "div",
}));
vi.mock("@/components/detection/csv-export-dialog", () => ({
  CsvExportConfirmDialog: "div",
}));
vi.mock("@/components/detection/use-csv-export", () => ({
  useCsvExport: () => ({
    status: { kind: "idle" },
    start: vi.fn(),
    confirmAndContinue: vi.fn(),
    cancelConfirmation: vi.fn(),
    dismissError: vi.fn(),
  }),
}));

type ShellModule = typeof import("@/components/detection/detection-shell");

describe("formatForbiddenSensorMessage (#278)", () => {
  // Mid-session scope change: every offending id is still in the page-
  // session cache (the operator selected them moments ago, before the
  // admin revoked their customer scope). The recovery banner can name
  // each one — the cached-name branch the issue's acceptance describes.
  it("resolves every id from the cache when all sensors are still cached", async () => {
    const mod: ShellModule = await import(
      "@/components/detection/detection-shell"
    );
    const result = mod.formatForbiddenSensorMessage(
      ["s1", "s2"],
      [
        { id: "s1", name: "alpha.example" },
        { id: "s2", name: "beta.example" },
        { id: "s3", name: "gamma.example" },
      ],
    );
    expect(result).toEqual({
      names: "alpha.example, beta.example",
      unresolvedCount: 0,
    });
  });

  // URL-tampered / stale-share-link path: the offending id was never
  // in the cache, so no name lookup is possible without an extra
  // fetch (out of scope per the issue). The banner falls back to a
  // count so the operator at least sees the scope of the problem.
  it("falls back to a count when no id resolves to a cached name", async () => {
    const mod: ShellModule = await import(
      "@/components/detection/detection-shell"
    );
    const result = mod.formatForbiddenSensorMessage(
      ["unknown-1", "unknown-2"],
      [{ id: "s1", name: "alpha.example" }],
    );
    expect(result).toEqual({ names: "", unresolvedCount: 2 });
  });

  // Mixed path: some ids resolved (operator-selected, still cached),
  // others did not (URL-injected). The banner combines both pieces of
  // information so the operator can identify the named selections and
  // still see that other unresolved selections exist.
  it("mixes resolved names with a count for unresolved ids", async () => {
    const mod: ShellModule = await import(
      "@/components/detection/detection-shell"
    );
    const result = mod.formatForbiddenSensorMessage(
      ["s1", "tampered", "s2", "stale"],
      [
        { id: "s1", name: "alpha.example" },
        { id: "s2", name: "beta.example" },
      ],
    );
    expect(result).toEqual({
      names: "alpha.example, beta.example",
      unresolvedCount: 2,
    });
  });

  // Empty id list never reaches the banner (the shell short-circuits
  // on `ids === null || ids.length === 0`), but the helper itself
  // must still return a well-defined empty result so callers can
  // safely invoke it without a length guard.
  it("returns an empty message for an empty id list", async () => {
    const mod: ShellModule = await import(
      "@/components/detection/detection-shell"
    );
    expect(mod.formatForbiddenSensorMessage([], [])).toEqual({
      names: "",
      unresolvedCount: 0,
    });
  });
});
