import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Minimal integration config for the ApplyAttempt lifecycle tests
 * (#359). Connects to PostgreSQL directly via DATABASE_URL — no
 * Next.js dev server, no mock GraphQL server, no mTLS material.
 *
 * Migrations must already be applied (the tests assume the
 * `apply_attempts` table from `migrations/auth/0023_apply_attempts.sql`
 * exists in the target DB, plus the round-1 once-only-emission slot
 * from `0024_apply_attempts_succeeded_audit_emitted_at.sql` and the
 * round-2 emission-recovery slot from
 * `0025_apply_attempts_succeeded_audit_completed_at.sql`).
 */
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
    include: ["src/__integration__/apply-attempts/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
