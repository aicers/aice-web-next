import { defineConfig, devices } from "@playwright/test";

/**
 * Integrated e2e config for the analyze-bridge Send flow (#635).
 *
 * Unlike the sibling `e2e/playwright.config.ts`, this config does NOT
 * spawn a `next dev` web server or in-process mock GraphQL servers.
 * It points at an externally provisioned multi-service stack on real
 * cross-origin hostnames (the "named equivalent" of `docker-compose.e2e.yml`
 * in #635 acceptance criteria). See `e2e/integrated/README.md` for the
 * operator setup checklist.
 *
 * Default hostnames assume the multi-host OrbStack reference setup
 * (M1 = aice-web-next, M3 = aimer-web + Keycloak + aimer). Override via
 * env vars when the operator runs the stack elsewhere (e.g. CI compose).
 */

const AICE_WEB_NEXT_URL =
  process.env.AICE_WEB_NEXT_URL ??
  "https://001.aice-web-next.aiceweb-host.test.local:9443";

const AIMER_WEB_URL =
  process.env.AIMER_WEB_URL ??
  "https://001.aimer-web.aimer-web-host.test.local:19443";

// Surface the resolved URLs to specs via process.env so they can pull
// them without re-implementing the default fallback in every helper.
process.env.AICE_WEB_NEXT_URL = AICE_WEB_NEXT_URL;
process.env.AIMER_WEB_URL = AIMER_WEB_URL;

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.PLAYWRIGHT_WORKERS
    ? Number(process.env.PLAYWRIGHT_WORKERS)
    : 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }], ["list"]],
  use: {
    baseURL: AICE_WEB_NEXT_URL,
    // The integrated stack uses internal-CA TLS for both aice-web-next
    // and aimer-web origins. Playwright cannot install the CA into its
    // bundled browsers without per-engine workarounds, so trust the
    // origins by config. Operators MUST ensure DNS for both hostnames
    // resolves to the running services (see README.md §"DNS").
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // The three engine projects run sequentially via `dependencies` to
  // avoid hammering the shared admin account's sign-in rate-limit window
  // (no test-only reset endpoint exists on the prod build under test).
  // Each engine still gets full coverage; CI runtime grows linearly with
  // engine count, which is acceptable for the bounded analyze-bridge
  // scope (5 scenarios × 3 engines).
  projects: [
    {
      name: "analyze-bridge-chromium",
      testMatch: ["analyze-bridge.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "analyze-bridge-firefox",
      testMatch: ["analyze-bridge.spec.ts"],
      dependencies: ["analyze-bridge-chromium"],
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "analyze-bridge-webkit",
      testMatch: ["analyze-bridge.spec.ts"],
      dependencies: ["analyze-bridge-firefox"],
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
