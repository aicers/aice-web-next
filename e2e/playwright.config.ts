import { defineConfig, devices } from "@playwright/test";

// Build webServer.env: only set values that are explicitly provided
// via environment variables (e.g., from CI). Omitted keys let Next.js
// fall back to .env.local for local development.
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  const keys = [
    "DATABASE_URL",
    "AUDIT_DATABASE_URL",
    "DATA_DIR",
    "CSRF_SECRET",
    "INIT_ADMIN_USERNAME",
    "INIT_ADMIN_PASSWORD",
    "DEFAULT_LOCALE",
  ] as const;

  for (const key of keys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}

export default defineConfig({
  globalSetup: "./global-setup.ts",
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: buildEnv(),
  },
});
