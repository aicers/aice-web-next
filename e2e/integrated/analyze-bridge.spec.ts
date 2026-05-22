import { expect, test } from "@playwright/test";

import {
  AIMER_WEB_URL,
  completeKeycloakSignIn,
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
    browserName,
  }) => {
    // Sub-task 2 scenario 1.
    //
    // The body below runs end-to-end on the reference multi-host
    // stack as far as the analyze-bridge `/continue` step —
    // Keycloak interactive login, OIDC callback, bridge session
    // creation all succeed. The remaining failure is
    // `authorization_failed` from `authorize(...)` inside
    // `runAnalyzeFlow`'s pre-flight check, plus storage / aimer
    // calls downstream. The contract that must hold on the
    // operator's stack before this fixme can be lifted is itself
    // out of scope for this PR (it is aimer-web operational
    // setup, not aice-web-next code under test) — checklist:
    //
    //   1. Keycloak realm `aimer` carries built-in `profile` /
    //      `email` client scopes with an OIDC user-property
    //      mapper producing `preferred_username`.
    //   2. `aimer-web` Keycloak client default scopes include
    //      `profile` and `email`.
    //   3. Keycloak `KC_HTTP_RELATIVE_PATH=/auth` + nginx
    //      `proxy_pass http://keycloak-prod:8080;` (no trailing
    //      slash) so `/auth/realms/...` reaches Keycloak instead
    //      of bouncing to `/auth/admin/`.
    //   4. aimer-web `KEYCLOAK_URL` includes the `/auth` suffix.
    //   5. aimer-web `AIMER_GRAPHQL_ENDPOINT` points at the
    //      aimer LLM backend.
    //   6. aimer-web JWT signing keys pre-generated at
    //      `${DATA_DIR}/keys/ec-{private,public}.pem`.
    //   7. aimer-web auth_db rows: Keycloak test user matching
    //      `KEYCLOAK_TEST_USERNAME`, a `customers` row with the
    //      same `external_key` as the aice-web-next side and
    //      `database_status=active`, an
    //      `aice_environment_customers` link, and an
    //      `account_customer_memberships` row with a
    //      `general`-context role carrying `analyses:create`.
    //   8. Per-customer database created with all
    //      `migrations/customer/*.sql` applied.
    //   9. OpenBao Transit key `customer-<uuid>` (aes256-gcm96).
    //
    // The body itself is left as a runnable reference — flip
    // `test.fixme` to `test` once the contract holds. The
    // per-engine sign-in gate (firefox / webkit) ties into the
    // same follow-up.
    test.skip(
      browserName !== "chromium",
      "per-engine sign-in not yet wired (see global-setup.ts)",
    );

    await navigateToBlocklistConnEventDetail(page);

    const [bridgeTab] = await Promise.all([
      context.waitForEvent("page", { timeout: 30_000 }),
      (async () => {
        await page.getByTestId("aimer-send-button").click();
        await page.getByTestId("aimer-modal-send").click();
      })(),
    ]);

    await completeKeycloakSignIn(bridgeTab);

    // After Keycloak callback the flow chains aimer-web's
    // /api/auth/callback → /api/analysis/analyze-bridge/continue?id=<par_id>
    // → 302 to the result `viewUrl` shaped `/analysis?<params>`.
    await bridgeTab.waitForURL(/\/analysis(\?|$)/, { timeout: 60_000 });
    expect(bridgeTab.url()).toContain(new URL(AIMER_WEB_URL).hostname);

    // The original tab should still be on the event detail page
    // and not have lost interactivity.
    expect(page.url()).toMatch(/\/events\//);
    await expect(page.getByTestId("aimer-send-button")).toBeVisible();
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
