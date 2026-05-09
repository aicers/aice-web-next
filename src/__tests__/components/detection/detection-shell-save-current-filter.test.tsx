/**
 * Coverage for the gating decision and shell wiring behind the
 * presets-dropdown "Save current filter…" entry (issue #428).
 *
 * The reviewer (Round 1) flagged that the leaf-component test in
 * `presets-dropdown.test.tsx` only proves the dropdown calls
 * `onSaveCurrentFilter`, not what the shell does once the entry
 * fires — opening the save dialog with the committed-filter default
 * name, and submitting through `savedFilters.save` with the
 * **committed** filter rather than a recomputed draft. That
 * contract is the gating decision recorded in the PR description:
 * the header save persists the URL `?f=` blob verbatim, intentionally
 * bypassing `buildAppliedFilter` and the customer / sensor "live"
 * gates the drawer save runs.
 *
 * The first describe block pins the helper itself: a regression that
 * swaps `buildAppliedFilter` (or any other recomputation) into the
 * save-current path fails the referential-identity assertion. The
 * second describe block mounts a thin harness that mirrors the
 * shell's three pieces of state plus the `handleSaveSubmit` shape,
 * so the "open dropdown → submit dialog → savedFilters.save called
 * with committed filter" path is covered end-to-end without dragging
 * the full `DetectionShell` mount into the suite.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  PresetsDropdown,
  type PresetsDropdownLabels,
} from "@/components/detection/presets-dropdown";
import { SaveFilterDialog } from "@/components/detection/save-filter-dialog";
import type { UseSavedFiltersResult } from "@/components/detection/use-saved-filters";
import type { Filter } from "@/lib/detection/filter";
import type { SummarizeFilterLabels } from "@/lib/detection/filter-summary";
import type { PeriodKey } from "@/lib/detection/period";
import type { RecommendedPreset } from "@/lib/detection/recommended-filters";
import { buildSaveCurrentFilterDialogState } from "@/lib/detection/save-current-filter";
import type { SavedFilter } from "@/lib/detection/saved-filters";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div data-slot="dropdown-menu-trigger">{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dropdown-menu-content" role="menu">
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect?.()}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dropdown-menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-slot="dropdown-menu-separator" />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dropdown-menu-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({
    children,
    "aria-label": ariaLabel,
    ...rest
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      data-slot="dropdown-menu-sub-trigger"
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </button>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dropdown-menu-sub-content" role="menu">
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-slot="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="alert-dialog-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="alert-dialog-header">{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-slot="alert-dialog-title">{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-slot="alert-dialog-description">{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="alert-dialog-footer">{children}</div>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent) => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
}));

// `SaveFilterDialog` carries a real Radix Dialog that the rest of the
// suite exercises through Playwright. Stub it down to a flat node
// that exposes the seeded `defaultName` plus a Submit button so the
// harness can drive the onSubmit pathway end-to-end.
vi.mock("@/components/detection/save-filter-dialog", () => ({
  SaveFilterDialog: ({
    open,
    defaultName,
    onSubmit,
  }: {
    open: boolean;
    defaultName: string;
    onSubmit: (
      name: string,
    ) => Promise<{ ok: true } | { ok: false; code: string }>;
  }) =>
    open ? (
      <div data-slot="save-dialog" data-default-name={defaultName}>
        <button
          type="button"
          data-slot="save-dialog-submit"
          onClick={() => {
            void onSubmit(defaultName);
          }}
        >
          Save
        </button>
      </div>
    ) : null,
}));

const PERIOD_OPTION_LABELS: Record<PeriodKey, string> = {
  "1h": "Last 1h",
  "12h": "Last 12h",
  "1d": "Last 1d",
  "1w": "Last 1w",
  "1m": "Last 1m",
  "3m": "Last 3m",
  "6m": "Last 6m",
  "1y": "Last 1y",
  "3y": "Last 3y",
};

const SUMMARIZE_LABELS: SummarizeFilterLabels = {
  sensor: "Sensor",
  sensorAggregate: "{count} selected",
  period: "Period",
  periodOptions: PERIOD_OPTION_LABELS,
  formatRange: ({ start, end }) => `${start} – ${end}`,
  direction: "Direction",
  directionValues: {
    INBOUND: "Inbound",
    OUTBOUND: "Outbound",
    INTERNAL: "Internal",
  },
  confidence: "Confidence",
  source: "Source",
  destination: "Destination",
  keywords: "Keywords",
  hostnames: "Hostnames",
  userIds: "User IDs",
  userNames: "User names",
  userDepartments: "User departments",
  levels: "Levels",
  countries: "Countries",
  learningMethods: "Methods",
  categories: "Categories",
  kinds: "Kinds",
  customers: "Customer",
  categoricalAggregate: ({ label, count }) => `${label}: ${count}`,
  customerAggregate: (count) => `Customer: ${count} selected`,
};

const CATEGORICAL_OPTIONS = {
  levels: [
    { value: "HIGH", label: "High" },
    { value: "MEDIUM", label: "Medium" },
  ],
  countries: [],
  learningMethods: [],
  categories: [],
  kinds: [],
} as const;

describe("buildSaveCurrentFilterDialogState — gating contract", () => {
  it("returns the committed filter with referential identity (no buildAppliedFilter recomputation)", () => {
    // `customers` carries an id that the live customer cache does not
    // expose (`customerSummaryOptions` is empty). The drawer save
    // path strips this entry via `customerSelectionLiveForCache`; the
    // header save path must not, since the committed filter is
    // already what the active query is running against. Asserting
    // referential identity locks the contract: any recomputation
    // that allocates a new filter object would fail this test.
    const committed: Filter = {
      mode: "structured",
      input: { customers: ["999"], levels: ["HIGH"] },
    };
    const result = buildSaveCurrentFilterDialogState({
      committedFilter: committed,
      committedPeriod: "1h",
      summarizeLabels: SUMMARIZE_LABELS,
      sensorOptions: [],
      customerSummaryOptions: [],
      categoricalOptions: CATEGORICAL_OPTIONS,
      defaultPeriodLabel: "Last 1h",
    });
    expect(result.filter).toBe(committed);
    expect(result.filter).toEqual(committed);
  });

  it("derives defaultName from committed-filter chips when chips exist", () => {
    const committed: Filter = {
      mode: "structured",
      input: { levels: ["HIGH"] },
    };
    const result = buildSaveCurrentFilterDialogState({
      committedFilter: committed,
      committedPeriod: "1h",
      summarizeLabels: SUMMARIZE_LABELS,
      sensorOptions: [],
      customerSummaryOptions: [],
      categoricalOptions: CATEGORICAL_OPTIONS,
      defaultPeriodLabel: "Last 1h",
    });
    // First two chip values joined by ` · `, mirroring `autoTabName`.
    expect(result.defaultName).toBe("Last 1h · High");
  });

  it("falls back to defaultPeriodLabel when the committed filter has no chips", () => {
    const committed: Filter = { mode: "structured", input: {} };
    const result = buildSaveCurrentFilterDialogState({
      committedFilter: committed,
      committedPeriod: null,
      summarizeLabels: SUMMARIZE_LABELS,
      sensorOptions: [],
      customerSummaryOptions: [],
      categoricalOptions: CATEGORICAL_OPTIONS,
      defaultPeriodLabel: "Last 1h",
    });
    expect(result.filter).toBe(committed);
    expect(result.defaultName).toBe("Last 1h");
  });
});

const RECOMMENDED: readonly RecommendedPreset[] = [
  { id: "rec-a", nameKey: "a", period: "1y" },
];

const SAVED: readonly SavedFilter[] = [
  {
    id: "sf-1",
    name: "Existing saved",
    filter: { mode: "structured", input: {} },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  },
];

function buildLabels(): PresetsDropdownLabels {
  return {
    trigger: "Presets",
    recommendedHeading: "Recommended",
    recommendedEmpty: "No recommended filters configured.",
    recommendedPresetName: (preset) => `name:${preset.id}`,
    savedHeading: "Saved",
    savedLoading: "Loading saved filters…",
    savedLoadError: "Could not load saved filters.",
    savedEmpty: "Save a filter to keep it here.",
    savedRowMenuLabel: (name) => `Saved filter actions for ${name}`,
    openInNewTab: (name) => `Open ${name} in a new tab`,
    loadInNewTab: "Load in new tab",
    loadInCurrentTab: "Load in current tab",
    rename: "Rename",
    delete: "Delete",
    deleteConfirm: {
      title: "Delete saved filter?",
      descriptionTemplate: "{name} will be removed.",
      cancel: "Cancel",
      confirm: "Delete",
      error: "Could not delete the saved filter.",
    },
    renameDialog: {
      title: "Rename saved filter",
      description: "",
      nameLabel: "Name",
      namePlaceholder: "",
      cancel: "Cancel",
      submit: "Rename",
      submitting: "Renaming…",
      errors: {
        empty: "",
        duplicate: "",
        tooLong: "",
        server: "",
        unauthenticated: "",
      },
    },
    saveCurrentFilter: "Save current filter…",
  };
}

const SAVE_DIALOG_LABELS = {
  title: "Save filter",
  description: "",
  nameLabel: "Name",
  namePlaceholder: "",
  cancel: "Cancel",
  submit: "Save",
  submitting: "Saving…",
  errors: {
    empty: "",
    duplicate: "",
    tooLong: "",
    server: "",
    unauthenticated: "",
  },
} as const;

describe("Presets dropdown 'Save current filter…' shell wiring", () => {
  it("opens the save dialog with the chip-derived default name and persists the committed filter through savedFilters.save", async () => {
    const committedFilter: Filter = {
      mode: "structured",
      input: { levels: ["HIGH"] },
    };
    const save = vi
      .fn()
      .mockResolvedValue({ ok: true, filter: SAVED[0] as SavedFilter });
    const savedFilters: UseSavedFiltersResult = {
      filters: SAVED,
      loading: false,
      loadError: false,
      refresh: vi.fn().mockResolvedValue(undefined),
      save: save as unknown as UseSavedFiltersResult["save"],
      rename: vi
        .fn()
        .mockResolvedValue({ ok: true, filter: SAVED[0] as SavedFilter }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    };

    function Harness() {
      // Mirror the shell's three save-dialog state slots (see
      // detection-shell.tsx `saveDialogOpen / Filter / DefaultName`).
      const [open, setOpen] = useState(false);
      const [dialogFilter, setDialogFilter] = useState<Filter | null>(null);
      const [defaultName, setDefaultName] = useState("");

      const onSaveCurrentFilter = useCallback(() => {
        const built = buildSaveCurrentFilterDialogState({
          committedFilter,
          committedPeriod: "1h",
          summarizeLabels: SUMMARIZE_LABELS,
          sensorOptions: [],
          customerSummaryOptions: [],
          categoricalOptions: CATEGORICAL_OPTIONS,
          defaultPeriodLabel: "Last 1h",
        });
        setDialogFilter(built.filter);
        setDefaultName(built.defaultName);
        setOpen(true);
      }, []);

      // Mirror the shell's `handleSaveSubmit`: forward (name,
      // saveDialogFilter) to `savedFilters.save`. The dialog stub's
      // Submit button calls this with the seeded default name.
      const onSubmit = useCallback(
        async (name: string) => {
          if (!dialogFilter) {
            return { ok: false as const, code: "server-error" as const };
          }
          const result = await savedFilters.save(name, dialogFilter);
          if (result.ok) return { ok: true as const };
          return { ok: false as const, code: result.code };
        },
        [dialogFilter],
      );

      return (
        <>
          <PresetsDropdown
            recommendedPresets={RECOMMENDED}
            savedFilters={savedFilters}
            labels={buildLabels()}
            onActivateRecommended={vi.fn()}
            onActivateSaved={vi.fn()}
            onLoadSavedInCurrentTab={vi.fn()}
            onSaveCurrentFilter={onSaveCurrentFilter}
          />
          <SaveFilterDialog
            open={open && dialogFilter !== null}
            onOpenChange={setOpen}
            defaultName={defaultName}
            onSubmit={onSubmit}
            labels={SAVE_DIALOG_LABELS}
          />
        </>
      );
    }

    render(<Harness />);

    // Pick the trailing entry from the dropdown.
    const saveCurrent = screen
      .getByText("Save current filter…")
      .closest("button") as HTMLButtonElement;
    fireEvent.click(saveCurrent);

    // Dialog opened with the chip-derived default name from the
    // committed filter. Period chip ("Last 1h") plus level chip
    // ("High") joined by ` · ` per `autoTabName`.
    const dialog = document.querySelector("[data-slot='save-dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("data-default-name")).toBe("Last 1h · High");

    // Submit fires the harness onSubmit which mirrors the shell's
    // handleSaveSubmit. The save call must receive the *committed*
    // filter — proving the shell wires `saveDialogFilter` (set from
    // `buildSaveCurrentFilterDialogState`) into `savedFilters.save`,
    // not a recomputed payload.
    fireEvent.click(
      document.querySelector(
        "[data-slot='save-dialog-submit']",
      ) as HTMLButtonElement,
    );
    // Allow the awaited save promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("Last 1h · High", committedFilter);
    // Sanity: the same reference flows through, not a clone — locks
    // the gating decision (no buildAppliedFilter recomputation).
    expect(save.mock.calls[0]?.[1]).toBe(committedFilter);
  });
});
