import { expect, test } from "@playwright/test";

import { AIMER_WEB_URL } from "./helpers";

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
  test.skip("debug: detection events list + first event detail", async ({
    page,
  }) => {
    await page.goto("/detection");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "test-results/debug-detection-list.png",
      fullPage: true,
    });
    const firstRow = page.locator("a[href*='/events/']").first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.waitForLoadState("networkidle");
      await page.screenshot({
        path: "test-results/debug-event-detail.png",
        fullPage: true,
      });
    }
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

  test.fixme("tamper context_jti → invalid_analyze_params_token", async ({
    page,
  }) => {
    // Sub-task 3 scenario 1.
    // Use page.route() to intercept the multipart POST to
    // <aimer-web>/api/analysis/analyze-bridge and re-sign the
    // analyze_params_token claim `context_jti` with a non-matching
    // value (or substitute a deliberately broken token from a test
    // mint helper). Assert the new tab lands on aimer-web's styled
    // error page with body containing the code
    // "invalid_analyze_params_token".
    void page;
  });

  test.fixme("tamper payload_hash → invalid_analyze_params_token", async ({
    page,
  }) => {
    // Sub-task 3 scenario 2.
    // Same as above but the tampered token carries a payload_hash
    // that does not match sha256(events_data).
    void page;
  });

  test.fixme("tamper envelope_hash → invalid_analyze_params_token", async ({
    page,
  }) => {
    // Sub-task 3 scenario 3.
    // Same as above but the tampered token carries an envelope_hash
    // that does not match sha256(events_envelope JWS bytes).
    void page;
  });
});
