/**
 * Coverage for the on-demand Presets dropdown that replaced the
 * always-visible Saved / Recommended left rail (issue #428).
 *
 * The Radix DropdownMenu / AlertDialog / Dialog primitives the
 * production code uses rely on portals and pointer-events that are
 * brittle under jsdom — the rest of the Detection suite exercises
 * the live primitive surface through Playwright. Here we shim the
 * primitives down to plain DOM containers so the unit suite can
 * focus on the dropdown's wiring logic: section composition, state
 * tri-state rendering for saved filters, the per-row sub-menu's
 * activation handlers, and the trailing Save-current entry.
 *
 * The shim keeps every interactive element rendered (it does not
 * gate on an "open" state) so the tests assert against a flat tree
 * — an exact-match for what the live menu shows once a contributor
 * opens it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PresetsDropdown,
  type PresetsDropdownLabels,
} from "@/components/detection/presets-dropdown";
import type { UseSavedFiltersResult } from "@/components/detection/use-saved-filters";
import type { RecommendedPreset } from "@/lib/detection/recommended-filters";
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

// `SaveFilterDialog` is a non-trivial Radix Dialog with internal
// state; the dropdown's contract is "open the rename flow when the
// operator picks Rename" — a simpler stub captures the wiring without
// pulling the full Radix Dialog surface into the suite.
vi.mock("@/components/detection/save-filter-dialog", () => ({
  SaveFilterDialog: ({
    open,
    defaultName,
  }: {
    open: boolean;
    defaultName: string;
  }) =>
    open ? (
      <div data-slot="rename-dialog" data-default-name={defaultName}>
        rename dialog
      </div>
    ) : null,
}));

const RECOMMENDED: readonly RecommendedPreset[] = [
  { id: "rec-a", nameKey: "a", period: "1y" },
  { id: "rec-b", nameKey: "b", period: "3y" },
];

const SAVED: readonly SavedFilter[] = [
  {
    id: "sf-1",
    name: "Last 1h · Production",
    filter: { mode: "structured", input: { start: "2025-01-01T00:00:00Z" } },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "sf-2",
    name: "Last 1d · Inbound",
    filter: { mode: "structured", input: { start: "2025-01-01T00:00:00Z" } },
    createdAt: "2025-01-02T00:00:00Z",
    updatedAt: "2025-01-02T00:00:00Z",
  },
];

function buildLabels(
  overrides: Partial<PresetsDropdownLabels> = {},
): PresetsDropdownLabels {
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
    ...overrides,
  };
}

function buildSavedState(
  overrides: Partial<UseSavedFiltersResult> = {},
): UseSavedFiltersResult {
  return {
    filters: SAVED,
    loading: false,
    loadError: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    save: vi
      .fn()
      .mockResolvedValue({ ok: true, filter: SAVED[0] as SavedFilter }),
    rename: vi
      .fn()
      .mockResolvedValue({ ok: true, filter: SAVED[0] as SavedFilter }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe("PresetsDropdown", () => {
  it("renders Recommended, Saved, and Save-current sections in order with separators", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Save current filter…")).toBeTruthy();
    // Two top-level separators (Recommended/Saved boundary +
    // Saved/Save-current boundary) confirm the issue's "visually
    // separated" requirement. Per-row sub-menus add their own
    // separator between Load actions and Rename / Delete; the
    // assertion scopes to the parent menu so it isn't tripped by
    // the per-row separators that scale with `SAVED.length`.
    const content = document.querySelector(
      "[data-slot='dropdown-menu-content']",
    ) as HTMLElement;
    const topLevelSeparators = Array.from(
      content.querySelectorAll(
        ":scope > [data-slot='dropdown-menu-separator']",
      ),
    );
    expect(topLevelSeparators.length).toBe(2);
  });

  it("default click on a recommended preset fires onActivateRecommended with that preset", () => {
    const onActivate = vi.fn();
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={onActivate}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    const buttonA = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-preset-id") === "rec-a");
    expect(buttonA).toBeTruthy();
    fireEvent.click(buttonA as HTMLElement);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(RECOMMENDED[0]);
  });

  it("default click on a saved row fires onLoadSavedInNewTab with that filter", () => {
    const onNew = vi.fn();
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={onNew}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    const row = screen.getByText("Last 1h · Production");
    // Click the row's primary MenuItem (the name button itself).
    fireEvent.click(row.closest("button") as HTMLButtonElement);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith(SAVED[0]);
  });

  it("renders the saved-loading placeholder while the initial fetch is in flight", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState({ loading: true, filters: [] })}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );
    expect(
      document.querySelector("[data-slot='presets-dropdown-saved-loading']"),
    ).not.toBeNull();
    // The Saved heading still renders so the section is not hidden,
    // matching the issue's "muted placeholder, section not hidden"
    // requirement.
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("renders the saved-error placeholder with role=alert when loadError is set", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState({ loadError: true, filters: [] })}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load saved filters.");
  });

  it("renders the saved-empty placeholder when the saved list is empty", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState({ filters: [] })}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );
    expect(
      document.querySelector("[data-slot='presets-dropdown-saved-empty']"),
    ).not.toBeNull();
  });

  it("renders the recommended-empty placeholder when no presets are configured", () => {
    render(
      <PresetsDropdown
        recommendedPresets={[]}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );
    expect(screen.getByText("No recommended filters configured.")).toBeTruthy();
  });

  it("per-row sub-menu exposes Load in current tab and routes the filter through onLoadSavedInCurrentTab", () => {
    const onCurrent = vi.fn();
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={onCurrent}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    // Within the row, the "Load in current tab" sub-menu item is
    // rendered alongside Load-in-new-tab / Rename / Delete; pick the
    // first one that lives inside the row whose data-saved-filter-id
    // matches sf-1.
    const row = document.querySelector(
      "[data-saved-filter-id='sf-1']",
    ) as HTMLElement;
    expect(row).toBeTruthy();
    const subItems = row.querySelectorAll("[role='menuitem']");
    const currentTabItem = Array.from(subItems).find(
      (el) => el.textContent === "Load in current tab",
    ) as HTMLButtonElement;
    fireEvent.click(currentTabItem);
    expect(onCurrent).toHaveBeenCalledTimes(1);
    expect(onCurrent).toHaveBeenCalledWith(SAVED[0]);
  });

  it("Rename action opens the rename dialog seeded with the saved filter's name", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    const row = document.querySelector(
      "[data-saved-filter-id='sf-2']",
    ) as HTMLElement;
    const renameItem = Array.from(
      row.querySelectorAll("[role='menuitem']"),
    ).find((el) => el.textContent === "Rename") as HTMLButtonElement;
    fireEvent.click(renameItem);

    const dialog = document.querySelector("[data-slot='rename-dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("data-default-name")).toBe("Last 1d · Inbound");
  });

  it("Delete action opens the confirm dialog and Confirm calls state.remove with the filter id", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState({ remove })}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={vi.fn()}
      />,
    );

    const row = document.querySelector(
      "[data-saved-filter-id='sf-1']",
    ) as HTMLElement;
    const deleteItem = Array.from(
      row.querySelectorAll("[role='menuitem']"),
    ).find((el) => el.textContent === "Delete") as HTMLButtonElement;
    fireEvent.click(deleteItem);

    const confirm = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    // `handleConfirmDelete` is async; let the microtask resolve.
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith("sf-1");
  });

  it("Save current filter… fires onSaveCurrentFilter when the action is enabled", () => {
    const onSave = vi.fn();
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
        onSaveCurrentFilter={onSave}
      />,
    );

    const item = screen.getByText("Save current filter…");
    fireEvent.click(item.closest("button") as HTMLButtonElement);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("omits the Save current entry when no onSaveCurrentFilter handler is provided", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        savedFilters={buildSavedState()}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
      />,
    );
    expect(screen.queryByText("Save current filter…")).toBeNull();
    // The Save-current separator is the second top-level one; with
    // the action gone the dropdown is left with just the
    // Recommended/Saved divider at the parent menu level (per-row
    // sub-menu separators are scoped inside their sub-content).
    const content = document.querySelector(
      "[data-slot='dropdown-menu-content']",
    ) as HTMLElement;
    const topLevelSeparators = Array.from(
      content.querySelectorAll(
        ":scope > [data-slot='dropdown-menu-separator']",
      ),
    );
    expect(topLevelSeparators.length).toBe(1);
  });

  it("omits the Saved section entirely when no savedFilters state is supplied", () => {
    render(
      <PresetsDropdown
        recommendedPresets={RECOMMENDED}
        labels={buildLabels()}
        onActivateRecommended={vi.fn()}
        onLoadSavedInNewTab={vi.fn()}
        onLoadSavedInCurrentTab={vi.fn()}
      />,
    );
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Save current filter…")).toBeNull();
  });
});
