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
  test("harness smoke: sign-in page renders on the configured origin", async ({
    page,
  }) => {
    // Smoke test for the integrated harness itself. Proves the operator's
    // multi-host stack is reachable, DNS resolves, TLS trust is configured,
    // and aice-web-next is serving requests. Does NOT exercise sign-in
    // (the prod build's rate-limit window has no test-only reset and the
    // shared admin account would be exhausted across the three-engine
    // matrix). The real scenarios below sign in once per engine.
    const response = await page.goto("/sign-in");
    expect(response?.ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: /sign into your account/i }),
    ).toBeVisible();
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
