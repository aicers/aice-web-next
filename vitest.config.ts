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
          ],
        },
      },
    ],
  },
});
