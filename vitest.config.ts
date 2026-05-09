import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(
        __dirname,
        "src/__tests__/mocks/server-only.ts",
      ),
    },
  },
  test: {
    exclude: [
      "node_modules",
      "e2e",
      ".next",
      ".claude/worktrees",
      ".worktrees",
      "src/__integration__",
    ],
    // Per-issue acceptance for #315 ("Standalone local test harness …
    // using React Testing Library + Vitest") requires real DOM
    // interactions for the per-service form tests. Scope jsdom to that
    // directory so the rest of the suite keeps the existing
    // SSR-via-`renderToStaticMarkup` baseline; broader adoption is
    // tracked as a separate cross-repo decision.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: [
            "src/__tests__/components/node/forms/**/*.test.{ts,tsx}",
            "src/__tests__/components/node/apply-preview-modal.test.tsx",
            "src/__tests__/components/node/node-edit-dialog-reopen.test.tsx",
            "src/__tests__/components/node/node-edit-dialog-sensor-pool-refresh.test.tsx",
            "src/__tests__/components/node/node-detail-dashboard.test.tsx",
            "src/__tests__/components/node/node-detail-service-grid.test.tsx",
            "src/__tests__/components/node/resource-sparkline.test.tsx",
            // Reviewer Round 6 #3 (#384): real-render tests for the
            // Customer drawer field's loading / error / empty / ready
            // branches and the wrapper-owned customer cache lifecycle.
            "src/__tests__/components/detection/customer-multi-select-render.test.tsx",
            "src/__tests__/components/detection/detection-tabs-shell-customer-cache.test.tsx",
            // Issue #428: the new on-demand presets dropdown replaces
            // the always-visible left rail. Coverage exercises the
            // open/close cycle, recommended preset activation, saved-
            // filter activation + per-row actions, the loading/empty/
            // error tri-state, and the "Save current filter…" entry.
            "src/__tests__/components/detection/presets-dropdown.test.tsx",
            // Round 1 review follow-up: shell-level coverage for the
            // presets-dropdown "Save current filter…" gating contract
            // and end-to-end save wiring (committed filter persisted
            // through `savedFilters.save` without re-running through
            // `buildAppliedFilter`).
            "src/__tests__/components/detection/detection-shell-save-current-filter.test.tsx",
            // Issue #429 §3 + §6: stale-data inline notice gated on
            // a match-focus event. Needs a real DOM because the
            // notice's gating effect runs on mount and the Refresh
            // button click clears local React state.
            "src/__tests__/components/detection/result-list-stale-focus.test.tsx",
            // Issue #437 (Reviewer Round 1): the bridge URL save
            // path must reset the input draft to the canonical
            // (trailing-slash-stripped) value, and the customer
            // external_key info line must degrade to a total-only
            // form when the per-customer column has not yet shipped.
            "src/__tests__/components/settings/aimer-integration-panel-render.test.tsx",
            // Issue #440: Send to Aimer modal + hidden-form submit
            // contract (DOM-level acceptance criteria — successful
            // submit leaves the form attached, failure paths tear it
            // down before rendering the error).
            "src/__tests__/components/events/aimer-banner.test.tsx",
            // Issue #440 (acceptance: prop forwarding):
            // EventInvestigation → OverviewTab → AimerBanner threads
            // `locator`, `candidates`, `customerBridgeEligible`, and
            // `aimerSetup` unchanged.
            "src/__tests__/components/events/overview-tab-forwarding.test.tsx",
            // Issue #452 (Reviewer Round 1): real-render coverage of
            // the Triage period-change confirmation flow — pivoting
            // and then changing the period must surface an
            // `AlertDialog` whose Cancel preserves the trail and
            // whose Confirm clears it.
            "src/__tests__/components/triage/triage-shell.test.tsx",
            // Issue #452 (Reviewer Round 5): pivot panel must hide the
            // "Showing 50 of N" hint while the group is collapsed at
            // the default 10 rows, and only surface it once the user
            // clicks Show more.
            "src/__tests__/components/triage/related-events-panel.test.tsx",
          ],
          setupFiles: ["src/__tests__/setup/dom-setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          exclude: [
            "node_modules",
            "e2e",
            ".next",
            ".claude/worktrees",
            ".worktrees",
            "src/__integration__",
            "src/__tests__/components/node/forms/**/*.test.{ts,tsx}",
            "src/__tests__/components/node/apply-preview-modal.test.tsx",
            "src/__tests__/components/node/node-edit-dialog-reopen.test.tsx",
            "src/__tests__/components/node/node-edit-dialog-sensor-pool-refresh.test.tsx",
            "src/__tests__/components/node/node-detail-dashboard.test.tsx",
            "src/__tests__/components/node/node-detail-service-grid.test.tsx",
            "src/__tests__/components/node/resource-sparkline.test.tsx",
            "src/__tests__/components/detection/customer-multi-select-render.test.tsx",
            "src/__tests__/components/detection/detection-tabs-shell-customer-cache.test.tsx",
            "src/__tests__/components/detection/presets-dropdown.test.tsx",
            "src/__tests__/components/detection/detection-shell-save-current-filter.test.tsx",
            "src/__tests__/components/detection/result-list-stale-focus.test.tsx",
            "src/__tests__/components/settings/aimer-integration-panel-render.test.tsx",
            "src/__tests__/components/events/aimer-banner.test.tsx",
            "src/__tests__/components/events/overview-tab-forwarding.test.tsx",
            "src/__tests__/components/triage/triage-shell.test.tsx",
            "src/__tests__/components/triage/related-events-panel.test.tsx",
          ],
        },
      },
    ],
  },
});
