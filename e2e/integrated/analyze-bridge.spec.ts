import { expect, test } from "@playwright/test";

import {
  AIMER_WEB_URL,
  loadSigningKey,
  navigateToBlocklistConnEventDetail,
} from "./helpers";
import { type CrossBindingClaim, tamperAnalyzeParamsToken } from "./lib/tamper";

/**
 * Integrated e2e coverage for the analyze-bridge Send flow (#635).
 *
 * Scope per #635:
 *   - §2 cross-site happy path: cold (interactive OIDC) + cached (silent SSO)
 *   - §3 cross-binding tamper: context_jti / payload_hash / envelope_hash
 *
 * Runs against an externally provisioned multi-service stack (see
 * `e2e/integrated/README.md`). Each scenario assumes the operator has
 * seeded:
 *   - aice-web-next: admin account, customer with `external_key`, at
 *     least one REview event whose detail page renders `<AimerBanner>`
 *     with that customer in `candidates`, `aimer_default_model_name` +
 *     `aimer_default_model` + active signing key
 *   - aimer-web: trust_registry row matching aice-web-next's `kid`
 *   - Keycloak: realm `aimer`, test user, redirect URI list including
 *     `<aimer-web>/api/auth/callback`
 *
 * Scenarios that still need seed automation are gated with `test.fixme`
 * — they fail loudly with a TODO until the seeding helper lands.
 */

test.describe("analyze-bridge integrated e2e", () => {
  test("harness smoke: storageState reaches an authenticated route", async ({
    page,
  }) => {
    // Smoke test for the integrated harness itself. The global setup
    // signed in once via the JSON API; this proves the resulting
    // storageState carries through to all engine contexts (DNS, TLS,
    // cookie domain attrs, baseURL all line up). Failure here means
    // the harness is wrong, not the analyze-bridge code under test.
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/sign-in/);
  });

  // Debug-only navigator used while seeding the scenarios. Skipped on
  // green runs; lift the skip locally to inspect event-list + banner
  // state during fixme implementation. Removed once the scenarios are
  // green and the seeding helpers are documented.
  test.skip("debug: navigate to a Send-eligible event detail", async ({
    page,
  }) => {
    // Reference walk-through that lands on an event whose detail page
    // shows the AimerBanner Send button ENABLED — useful while
    // iterating the fixme scenarios. Pre-requisite: both seed scripts
    // under `seed/` have been run on the multi-host stack (see
    // README.md §"Seed scripts").
    await page.goto("/detection");
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: /^Presets$/ }).click();
    await page.getByText("3 years", { exact: true }).click();
    await page.locator("text=Detected events").waitFor();
    await page.waitForTimeout(2000);
    // The Send-button enablement requires the event's GraphQL
    // fragment to include `origCustomer { id name }`. Some event
    // types omit it (DomainGenerationAlgorithm, NonBrowser — see
    // src/lib/detection/queries.ts:289), so pick a type that does
    // (e.g. BlocklistConn, DnsCovertChannel).
    const blocklistRow = page
      .locator("li")
      .filter({ hasText: /Blocklist Connection/i })
      .first();
    await blocklistRow
      .getByRole("button", { name: /investigation|investigate/i })
      .click();
    await page.waitForURL(/\/events\//, { timeout: 15_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: "test-results/debug-event-detail.png",
      fullPage: true,
    });
  });

  test.fixme("cold OIDC happy path: first-visit interactive Keycloak sign-in", async ({
    page,
    context,
  }) => {
    // Sub-task 2 scenario 1.
    // 1. Fresh context — no Keycloak session cookie.
    // 2. Sign in to aice-web-next as admin.
    // 3. Navigate to a seeded event detail page; assert AimerBanner is
    //    rendered with the seeded customer selected.
    // 4. Click [data-testid="aimer-send-button"] → modal opens →
    //    click [data-testid="aimer-modal-send"].
    // 5. Wait for context.waitForEvent("page") to capture the new tab.
    // 6. Assert the new tab navigates through Keycloak interactive
    //    sign-in (form submit → callback → analyze-bridge/continue →
    //    result page). PAR row transitions pending → consumed.
    // 7. Assert original tab is still on the event detail page and
    //    interactive (click somewhere benign, expect no nav).
    void page;
    void context;
    void AIMER_WEB_URL;
  });

  test.fixme("cached SSO happy path: subsequent-visit silent Keycloak SSO", async ({
    page,
    context,
  }) => {
    // Sub-task 2 scenario 2.
    // 1. Reuse a context already authenticated to Keycloak (run the
    //    cold scenario first in the same context, OR pre-warm via API).
    // 2. Click Send → window.open → form POST → live-session
    //    short-circuit OR transparent silent SSO.
    // 3. Assert `runAnalyzeFlow` hits the cache (no new aimer call) —
    //    verified via aimer-stub call counter or aimer log.
    // 4. Assert `cached: true` on the stored event_analysis_result row
    //    (query aimer-web postgres directly via pg client).
    // Also covers: `?aimerForce=1` URL param arms a force-bypass on
    // the next click; force=true causes aimer-web to re-invoke the
    // analyzer instead of returning cached row; URL param is stripped
    // after consumption.
    void page;
    void context;
  });

  // Sub-task 3 §3 cross-binding tamper coverage. One parametrized
  // test per claim — JWS is re-signed with the same key so the
  // signature still verifies; only the cross-binding match fails,
  // which is the contract under test (aimer-web#274 §10 error code
  // `invalid_analyze_params_token`).
  for (const claim of [
    "context_jti",
    "payload_hash",
    "envelope_hash",
  ] as const) {
    test(`tamper ${claim} → invalid_analyze_params_token`, async ({
      page,
      context,
      browserName,
    }) => {
      // The harness's shared storageState is created under chromium
      // (see global-setup.ts) so its session-bound UA fingerprint
      // only matches the chromium engine. firefox/webkit attaching
      // the same state trip `assessIpUaRisk` in
      // src/lib/auth/guard.ts and the first mutating API call
      // returns 401 REAUTH_REQUIRED. Per-engine sign-in is a
      // follow-up (will be done alongside the cold OIDC happy path,
      // which also needs a fresh-context sign-in surface).
      test.skip(
        browserName !== "chromium",
        "per-engine sign-in not yet wired (see global-setup.ts)",
      );
      const signingKey = loadSigningKey();
      test.skip(
        signingKey === null,
        "signing key not provisioned — see global-setup.ts SIGNING_KEY_FETCH_COMMAND",
      );

      // Intercept the BFF's mint response and tamper the named
      // cross-binding claim before the browser ever builds the form.
      await page.route("**/api/aimer/analyze-envelope", async (route) => {
        const response = await route.fetch();
        if (!response.ok()) {
          // Bubble the BFF's own error response back unchanged — the
          // assertion further down will surface the mismatch with a
          // clearer message than a malformed-token rejection from
          // aimer-web would.
          await route.fulfill({ response });
          return;
        }
        const body = (await response.json()) as {
          analyzeParamsToken: string;
          [k: string]: unknown;
        };
        body.analyzeParamsToken = tamperAnalyzeParamsToken(
          body.analyzeParamsToken,
          claim as CrossBindingClaim,
          signingKey as NonNullable<typeof signingKey>,
        );
        await route.fulfill({
          status: response.status(),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      });

      await navigateToBlocklistConnEventDetail(page);

      // Send → modal-confirm. The modal click (a) reserves a named
      // tab via window.open and (b) submits the hidden form into
      // that tab. The new page is what aimer-web's error response
      // renders; assert against its body.
      const [newPage] = await Promise.all([
        context.waitForEvent("page", { timeout: 30_000 }),
        (async () => {
          await page.getByTestId("aimer-send-button").click();
          await page.getByTestId("aimer-modal-send").click();
        })(),
      ]);
      // The named tab opens at `about:blank` and only navigates once
      // the hidden form's submit dispatches into it. Wait for the
      // URL to reach aimer-web's origin before asserting on body.
      await newPage.waitForURL(
        (url) => url.hostname === new URL(AIMER_WEB_URL).hostname,
        { timeout: 30_000 },
      );
      await newPage.waitForLoadState("domcontentloaded");
      // Sanity check: the new tab actually navigated to aimer-web's
      // origin (so the tampered token did reach the wire and the
      // assertion below is not just matching same-origin error text).
      expect(newPage.url()).toContain(new URL(AIMER_WEB_URL).hostname);
      await expect(newPage.locator("body")).toContainText(
        "invalid_analyze_params_token",
        { timeout: 15_000 },
      );
    });
  }
});
