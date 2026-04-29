import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { ensureTestCerts } from "../src/test-harness/test-certs";
import { resolveDataDir } from "./data-dir";
import { mockServerUrl } from "./mock-server-state";

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

  // Point the dev server at the mock REview GraphQL endpoint that
  // global-setup.ts brings up. The mock is served over HTTPS + mTLS using
  // short-lived certs, so the dev server reaches it via the production
  // mTLS code path in src/lib/mtls.ts (no bypass involved — the bypass's
  // NODE_ENV gate is unreachable from `next dev`, since `next dev` forces
  // NODE_ENV=development).
  env.REVIEW_GRAPHQL_ENDPOINT = mockServerUrl();

  // The mock server is an HTTPS + mTLS endpoint. Generate (or reuse)
  // short-lived test certs now — before webServer starts — so the dev
  // server's mTLS module reads the test CA + client cert + key via these
  // env vars. globalSetup picks up the same files when it starts the mock.
  //
  // Both this file and globalSetup must resolve DATA_DIR identically
  // (process.env → .env.local → "./data"); otherwise the dev-server env
  // and the mock-server cert directory drift apart on local runs with a
  // custom .env.local. Publish the resolved absolute path back into
  // env.DATA_DIR so the dev server inherits the same value.
  const dataDir = resolveDataDir();
  env.DATA_DIR = dataDir;
  const certs = ensureTestCerts(resolve(dataDir, "certs"));
  env.MTLS_CA_PATH = certs.paths.caPath;
  env.MTLS_CERT_PATH = certs.paths.clientCertPath;
  env.MTLS_KEY_PATH = certs.paths.clientKeyPath;
  // Also expose them to this process so globalSetup (which runs in this
  // process) and the admin client in specs can read the same paths.
  process.env.DATA_DIR = dataDir;
  process.env.MTLS_CA_PATH = certs.paths.caPath;
  process.env.MTLS_CERT_PATH = certs.paths.clientCertPath;
  process.env.MTLS_KEY_PATH = certs.paths.clientKeyPath;

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
        // Node specs share `nodeStatusList` catch-all stubs against the
        // global mock-server registry; running them in parallel across
        // workers lets one spec's catch-all hijack another spec's
        // polling response (the populated → tenant1 / populated → alive
        // swaps land last-registered-wins and overwrite the polling
        // buffer in unrelated tests). Hoist them into their own chained
        // projects below so only one node spec's catch-alls are live at
        // any given time.
        "node/list.spec.ts",
        "node/status.spec.ts",
        "node/create-edit.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "serial",
      testMatch: ["system-settings.spec.ts"],
      dependencies: ["parallel"],
      use: { ...devices["Desktop Chrome"] },
    },
    // Node specs register catch-all `nodeList` / `nodeStatusList` stubs
    // (e.g. the tenant-admin test swaps to `tenant1.json`, the live
    // polling test swaps to `alive.json`). Stub resolution does not
    // filter by `mockServerSession` scope, so two node specs running on
    // separate workers leak each other's fixtures into their polling
    // responses. Chain the two specs so one runs after the other; the
    // other suites stay parallel.
    {
      name: "node-status",
      testMatch: ["node/status.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "node-list",
      testMatch: ["node/list.spec.ts"],
      dependencies: ["node-status"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "node-create-edit",
      testMatch: ["node/create-edit.spec.ts"],
      dependencies: ["node-list"],
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
    // Never reuse an existing server. Playwright's webServer reuse would
    // skip `env` injection and adopt whatever process already holds the
    // port, so `REVIEW_GRAPHQL_ENDPOINT` / `MTLS_*` would not reach the app.
    // Future REview-backed scenarios would then silently hit the wrong
    // backend while the smoke spec still passes (it only probes `/` and
    // talks to the mock directly). Owning the app process every run is the
    // safer default for test infra; local devs with a persistent dev server
    // on :3000 must stop it before invoking `pnpm e2e`.
    reuseExistingServer: false,
    timeout: 120_000,
    env: buildEnv(),
  },
});
