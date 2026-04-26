import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock React + UI dependencies so we can import the pure helper
// without pulling the client component's runtime. Mirrors the
// pattern in `detection-shell-apply.test.ts`.
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
  useMemo: (fn: () => unknown) => fn(),
  useEffect: () => {},
  startTransition: (fn: () => void) => fn(),
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
  MoreVertical: "span",
  SlidersHorizontal: "span",
  Star: "span",
  X: "span",
  XIcon: "span",
}));
vi.mock("@/app/[locale]/(dashboard)/detection/actions", () => ({
  runEventQuery: vi.fn(),
}));
vi.mock("@/app/[locale]/(dashboard)/detection/sensor-actions", () => ({
  fetchSensors: vi.fn(),
}));
vi.mock("@/app/[locale]/(dashboard)/detection/saved-filter-actions", () => ({
  listSavedFilters: vi.fn(),
  saveFilter: vi.fn(),
  renameFilter: vi.fn(),
  deleteFilter: vi.fn(),
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
vi.mock("@/components/ui/dialog", () => ({
  Dialog: "div",
  DialogContent: "div",
  DialogDescription: "div",
  DialogFooter: "div",
  DialogHeader: "div",
  DialogTitle: "div",
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: "div",
  DropdownMenuContent: "div",
  DropdownMenuItem: "div",
  DropdownMenuSeparator: "div",
  DropdownMenuTrigger: "div",
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: "div",
  AlertDialogAction: "div",
  AlertDialogCancel: "div",
  AlertDialogContent: "div",
  AlertDialogDescription: "div",
  AlertDialogFooter: "div",
  AlertDialogHeader: "div",
  AlertDialogTitle: "div",
}));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("@/components/ui/label", () => ({ Label: "label" }));
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

import { computePeriodRange, DEFAULT_PERIOD_KEY } from "@/lib/detection/period";

type ShellModule = typeof import("@/components/detection/detection-shell");

describe("derivePeriodForFilter", () => {
  let derivePeriodForFilter: ShellModule["derivePeriodForFilter"];

  beforeAll(async () => {
    const mod = await import("@/components/detection/detection-shell");
    derivePeriodForFilter = mod.derivePeriodForFilter;
  });

  it("returns null for query-mode filters", () => {
    expect(
      derivePeriodForFilter({ mode: "query", text: "level:high" }),
    ).toBeNull();
  });

  it("returns null when start / end are absent", () => {
    expect(derivePeriodForFilter({ mode: "structured", input: {} })).toBeNull();
  });

  it("returns the matching preset key when start / end exactly match a preset", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const range = computePeriodRange(DEFAULT_PERIOD_KEY, now);
      expect(
        derivePeriodForFilter({
          mode: "structured",
          input: { start: range.start, end: range.end },
        }),
      ).toBe(DEFAULT_PERIOD_KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when the range does not match any preset", () => {
    expect(
      derivePeriodForFilter({
        mode: "structured",
        input: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-02T00:30:00Z",
        },
      }),
    ).toBeNull();
  });
});
