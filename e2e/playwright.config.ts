import { defineConfig, devices } from "@playwright/test";

// Build webServer.env: only set values that are explicitly provided
// via environment variables (e.g., from CI). Omitted keys let Next.js
// fall back to .env.local for local development.
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  const keys = [
    "DATABASE_URL",
    "DATABASE_ADMIN_URL",
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
  globalTeardown: "./global-teardown.ts",
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
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
      name: "parallel",
      testIgnore: [
        "mfa-enforcement.spec.ts",
        "mfa-sign-in.spec.ts",
        "rate-limit.spec.ts",
        "system-settings.spec.ts",
        "totp-profile.spec.ts",
        "webauthn.spec.ts",
        "webauthn-profile.spec.ts",
        "webauthn-sign-in.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "serial",
      testMatch: ["system-settings.spec.ts"],
      dependencies: ["parallel"],
      use: { ...devices["Desktop Chrome"] },
    },
    // These suites mutate the global mfa_policy row. Running them
    // in the same project with workers > 1 causes races, so each
    // file gets its own project chained via dependencies.
    {
      name: "mfa-policy-1",
      testMatch: ["mfa-sign-in.spec.ts"],
      dependencies: ["serial"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mfa-policy-2",
      testMatch: ["totp-profile.spec.ts"],
      dependencies: ["mfa-policy-1"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mfa-policy-3",
      testMatch: ["webauthn.spec.ts"],
      dependencies: ["mfa-policy-2"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mfa-policy-4",
      testMatch: ["webauthn-profile.spec.ts"],
      dependencies: ["mfa-policy-3"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mfa-policy-5",
      testMatch: ["webauthn-sign-in.spec.ts"],
      dependencies: ["mfa-policy-4"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mfa-policy-6",
      testMatch: ["mfa-enforcement.spec.ts"],
      dependencies: ["mfa-policy-5"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "isolated",
      testMatch: ["rate-limit.spec.ts"],
      dependencies: ["mfa-policy-6"],
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
