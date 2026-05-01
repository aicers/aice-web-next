import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { ensureTestCerts } from "../src/test-harness/test-certs";
import { resolveDataDir } from "./data-dir";
import { mockServerUrl } from "./mock-server-state";

function readLocalEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
    const env: Record<string, string> = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }

    return env;
  } catch {
    return {};
  }
}

const localEnv = readLocalEnv();

function getEnvVar(key: string, fallback: string): string {
  return process.env[key] ?? localEnv[key] ?? fallback;
}

function getAppUrl(): URL {
  const fallback = `http://localhost:${process.env.APP_PORT ?? "3000"}`;
  return new URL(process.env.BASE_URL ?? fallback);
}

const appUrl = getAppUrl();
const appBaseUrl = appUrl.toString().replace(/\/$/, "");
const appPort = appUrl.port || (appUrl.protocol === "https:" ? "443" : "80");
const detectionManualCaptureOnly =
  process.env.DETECTION_MANUAL_CAPTURE_ONLY === "1";
const configuredWorkers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : undefined;

// Build webServer.env: only set values that are explicitly provided
// via environment variables (e.g., from CI). Omitted keys let Next.js
// fall back to .env.local for local development.
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {
    DATABASE_URL: getEnvVar(
      "DATABASE_URL",
      "postgres://postgres:postgres@localhost:5432/auth_db",
    ),
    DATABASE_ADMIN_URL: getEnvVar(
      "DATABASE_ADMIN_URL",
      "postgres://postgres:postgres@localhost:5432/postgres",
    ),
    AUDIT_DATABASE_URL: getEnvVar(
      "AUDIT_DATABASE_URL",
      "postgres://audit_writer:changeme@localhost:5432/audit_db",
    ),
    DATA_DIR: getEnvVar("DATA_DIR", resolveDataDir()),
    CSRF_SECRET: getEnvVar(
      "CSRF_SECRET",
      "e2e-test-csrf-secret-at-least-32-chars!!",
    ),
    INIT_ADMIN_USERNAME: getEnvVar("INIT_ADMIN_USERNAME", "admin"),
    INIT_ADMIN_PASSWORD: getEnvVar("INIT_ADMIN_PASSWORD", "Admin1234!"),
    DEFAULT_LOCALE: getEnvVar("DEFAULT_LOCALE", "en"),
  };
  Object.assign(process.env, env);

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
  const dataDir = env.DATA_DIR;
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
  // The suite drives a single `next dev` process plus a shared mock REview
  // backend. Letting Playwright fan out to the host CPU count locally
  // overdrives that shared stack and triggers nondeterministic Next.js JSON
  // parse failures before the app logic is even reached. Default local runs to
  // one worker for stability, while still allowing explicit overrides for
  // debugging or CI tuning.
  workers: configuredWorkers ?? (process.env.CI ? 4 : 1),
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }]],
  use: {
    baseURL: appBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: detectionManualCaptureOnly
    ? [
        {
          name: "detection-screenshots-static",
          testMatch: ["detection-screenshots.spec.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "detection-screenshots-dynamic",
          testMatch: ["detection-manual-dynamic-screenshots.spec.ts"],
          dependencies: ["detection-screenshots-static"],
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : [
        {
          name: "parallel",
          testIgnore: [
            "mfa-enforcement.spec.ts",
            "mfa-sign-in.spec.ts",
            "rate-limit.spec.ts",
            // These suites mutate the shared worker-account state
            // (`must_change_password`, session rows, lockout counters,
            // or role-linked MFA state). When they share the default
            // parallel pool with broader UI/API coverage, a failed or
            // slow cleanup leaks into unrelated specs and causes
            // cross-file flakes. Run them in their own chained
            // projects below so each file gets a clean worker account.
            "accounts.spec.ts",
            "detection-pivot-identity.spec.ts",
            "lockout.spec.ts",
            "mfa-reset.spec.ts",
            "must-change-password.spec.ts",
            "session-policy.spec.ts",
            "system-settings.spec.ts",
            "totp-profile.spec.ts",
            "webauthn.spec.ts",
            "webauthn-profile.spec.ts",
            "webauthn-sign-in.spec.ts",
            // The Detection manual-capture suites mutate saved-filter/customer
            // state and the dynamic suite registers catch-all REview stubs.
            // Run them in isolated chained projects below so their global state
            // cannot leak into unrelated specs on other workers.
            "detection-screenshots.spec.ts",
            "detection-manual-dynamic-screenshots.spec.ts",
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
            "node/detail.spec.ts",
            "node/apply-preview.spec.ts",
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
        {
          name: "node-detail",
          testMatch: ["node/detail.spec.ts"],
          dependencies: ["node-create-edit"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "node-apply-preview",
          testMatch: ["node/apply-preview.spec.ts"],
          dependencies: ["node-detail"],
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
        {
          name: "stateful-accounts",
          testMatch: ["accounts.spec.ts"],
          dependencies: ["isolated"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "stateful-detection-pivot",
          testMatch: ["detection-pivot-identity.spec.ts"],
          dependencies: ["stateful-accounts"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "stateful-lockout",
          testMatch: ["lockout.spec.ts"],
          dependencies: ["stateful-detection-pivot"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "stateful-mfa-reset",
          testMatch: ["mfa-reset.spec.ts"],
          dependencies: ["stateful-lockout"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "stateful-must-change-password",
          testMatch: ["must-change-password.spec.ts"],
          dependencies: ["stateful-mfa-reset"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "stateful-session-policy",
          testMatch: ["session-policy.spec.ts"],
          dependencies: ["stateful-must-change-password"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "detection-screenshots-static",
          testMatch: ["detection-screenshots.spec.ts"],
          dependencies: ["stateful-session-policy"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "detection-screenshots-dynamic",
          testMatch: ["detection-manual-dynamic-screenshots.spec.ts"],
          dependencies: ["detection-screenshots-static"],
          use: { ...devices["Desktop Chrome"] },
        },
      ],
  webServer: {
    command: `node cleanup-orphaned-customers.mjs && pnpm dev --port ${appPort}`,
    url: appBaseUrl,
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
