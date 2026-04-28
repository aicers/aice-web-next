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
          ],
        },
      },
    ],
  },
});
