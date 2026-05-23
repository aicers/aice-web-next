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

  test("cold OIDC happy path: first-visit interactive Keycloak sign-in", async ({
    page,
    context,
  }) => {
    // The interactive Keycloak round-trip plus the live OpenAI
    // analysis call regularly takes 30-40 s on the reference stack,
    // so the default 30 s test timeout truncates the run before the
    // bridge tab reaches `/analysis?…`. Give the whole scenario two
    // minutes of headroom; the individual waits already cap their
    // own budgets.
    test.setTimeout(120_000);
    // Sub-task 2 scenario 1.
    //
    // Operator-stack contract that must hold on the reference
    // multi-host stack:
    //
    //   1. Keycloak realm `aimer` carries built-in `profile` /
    //      `email` client scopes with an OIDC user-property
    //      mapper producing `preferred_username`.
    //   2. `aimer-web` Keycloak client default scopes include
    //      `profile` and `email`.
    //   3. Keycloak `KC_HTTP_RELATIVE_PATH=/auth` + nginx
    //      `proxy_pass http://keycloak-prod:8080;` (no trailing
    //      slash) so `/auth/realms/...` reaches Keycloak
    //      instead of bouncing to `/auth/admin/`. nginx-prod
    //      must also pin `X-Forwarded-Port 19443` (not
    //      `$server_port`, which evaluates to 443 inside the
    //      container) so Keycloak's BACKCHANNEL_DYNAMIC URLs
    //      include the publicly-reachable port.
    //   4. aimer-web `KEYCLOAK_URL` includes the `/auth` suffix
    //      AND points at the public canonical origin (same
    //      KC_HOSTNAME the realm advertises), since Keycloak's
    //      iss claim is forced to KC_HOSTNAME under
    //      KC_HOSTNAME_STRICT=true.
    //   5. aimer-web `AIMER_GRAPHQL_ENDPOINT` points at the
    //      aimer LLM backend (with the mTLS client cert / key
    //      / CA paths set via `MTLS_*_PATH` env, since aimer is
    //      auth-mtls).
    //   6. aimer-web JWT signing keys pre-generated at
    //      `${DATA_DIR}/keys/ec-{private,public}.pem`. The keys
    //      live in the container layer, so any
    //      `--force-recreate` of next-app drops them and they
    //      must be regenerated by the operator before the next
    //      sign-in attempt.
    //   7. aimer-web auth_db rows: Keycloak test user matching
    //      `KEYCLOAK_TEST_USERNAME`, a `customers` row with the
    //      same `external_key` as the aice-web-next side and
    //      `database_status=active`, an
    //      `aice_environment_customers` link, and an
    //      `account_customer_memberships` row with a
    //      `general`-context role carrying `analyses:create`.
    //      The membership row binds to the existing `accounts`
    //      row whose `oidc_issuer` matches what KEYCLOAK_URL
    //      computes — if the issuer string drifts (e.g. switch
    //      from internal `keycloak-prod:8080` to the public
    //      canonical origin) the callback upserts a fresh
    //      account and the prior membership is orphaned,
    //      producing `bridge_no_access`.
    //   8. Per-customer database created with all
    //      `migrations/customer/*.sql` applied AND
    //      `GRANT ALL ON SCHEMA public` to **both**
    //      `aimer_customer` (runtime role) and
    //      `aimer_customer_owner` (migration role). The next-
    //      app startup runner uses the owner role; missing the
    //      owner grant flips the customer to
    //      `database_status=failed`, which then fails the
    //      `customers.status` check inside `authorize()`.
    //   9. OpenBao Transit key `customer-<uuid>` (aes256-gcm96)
    //      AND the `staging-events` Transit key, both readable
    //      by the token in aimer-web `BAO_TOKEN` env. A scoped
    //      token without `transit/datakey/*` rights fails the
    //      bridge with `Transit datakey/plaintext/staging-
    //      events failed (403)` and a generic `internal_error`.
    //  10. The aimer LLM backend's GraphQL schema matches what
    //      `runAnalyzeFlow` sends — both projects share
    //      `analyzeEvent(event, eventTime: DateTime!, name, model,
    //      lang)` via aimer-web's vendored SDL.

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

  test("cached SSO happy path: subsequent-visit silent Keycloak SSO", async ({
    page,
    context,
    browserName,
  }) => {
    // Sub-task 2 scenario 2.
    //
    // Run cold OIDC first (in this same context) to (a) establish a
    // Keycloak session cookie on aimer-web's origin and (b) populate
    // the `event_analysis_result` cache row for the target event.
    // The second click in the same context must then short-circuit:
    //   - aimer-web's `/api/analysis/analyze-bridge` sees a live
    //     session and skips the Keycloak round-trip — the bridge tab
    //     never lands on `/auth/realms/.../protocol/openid-connect/
    //     auth` (the login form).
    //   - aimer-web's `runAnalyzeFlow` finds the prior cache row and
    //     short-circuits without an `analyzeEvent` call, so the
    //     `/analysis?...` redirect arrives in a couple of seconds
    //     instead of the ~15 s the cold OpenAI call needs.
    //
    // `?aimerForce=1` armed on the event-detail URL forces aice-web-
    // next to ship `force=true` on the next click, which then makes
    // aimer-web bypass the cache and re-invoke the analyzer — timing
    // climbs back toward the cold-path budget. The URL param is
    // consumed (stripped) on the first click so a refresh does not
    // re-force (see `aimer-banner.tsx:220-228`).
    //
    // Webkit-specific carve-out: WebKit's stricter cross-site cookie
    // handling (ITP) drops aimer-web's session cookie between the
    // cold and cached popups, so the second click's `/api/analysis/
    // analyze-bridge/continue` lands on `{"error":"Unauthorized"}`
    // instead of the cached `/analysis?…` redirect. The cold and
    // tamper specs already exercise the analyze-bridge wiring on
    // webkit; the silent-SSO contract is meaningful only on engines
    // whose default cookie policy actually allows cross-site session
    // reuse (chromium / firefox here).
    test.skip(
      browserName === "webkit",
      "WebKit ITP partitions aimer-web's session cookie between popups; silent-SSO contract is engine-policy-dependent",
    );
    // The cold-path arm of this test does a live Keycloak round-trip
    // plus the OpenAI analysis; budget enough headroom for it (the
    // cached and forced arms are faster but share the same timeout).
    test.setTimeout(180_000);

    // ── Cold warm-up: same shape as the cold-OIDC test above, but
    // here it is a prerequisite, not the unit under test. ───────────
    await navigateToBlocklistConnEventDetail(page);
    const [coldBridgeTab] = await Promise.all([
      context.waitForEvent("page", { timeout: 30_000 }),
      (async () => {
        await page.getByTestId("aimer-send-button").click();
        await page.getByTestId("aimer-modal-send").click();
      })(),
    ]);
    await completeKeycloakSignIn(coldBridgeTab);
    await coldBridgeTab.waitForURL(/\/analysis(\?|$)/, { timeout: 60_000 });
    const coldViewUrl = coldBridgeTab.url();
    await coldBridgeTab.close();

    // ── Cached arm: a fresh Send in the same context. ───────────────
    // Re-open the event detail page (the modal was closed when the
    // first popup opened; landing here also exercises the live BFF
    // mint a second time so the cache lookup runs server-side).
    await navigateToBlocklistConnEventDetail(page);

    // Track Keycloak login-form hits — silent SSO MUST NOT show one.
    let keycloakLoginFormHits = 0;
    const onPopupRequest = (req: import("@playwright/test").Request) => {
      if (
        /\/auth\/realms\/[^/]+\/login-actions\/authenticate/.test(req.url())
      ) {
        keycloakLoginFormHits += 1;
      }
    };
    context.on("request", onPopupRequest);

    const cachedStartedAt = Date.now();
    const [cachedBridgeTab] = await Promise.all([
      context.waitForEvent("page", { timeout: 30_000 }),
      (async () => {
        await page.getByTestId("aimer-send-button").click();
        await page.getByTestId("aimer-modal-send").click();
      })(),
    ]);
    await cachedBridgeTab.waitForURL(/\/analysis(\?|$)/, { timeout: 30_000 });
    const cachedElapsedMs = Date.now() - cachedStartedAt;

    // Silent SSO: no Keycloak interactive login between cold and
    // cached. The cold round-trip already populated the form-hit
    // counter, but it was zeroed here — only the cached arm counts.
    expect(keycloakLoginFormHits).toBe(0);

    // Cache hit: the second `/analysis?...` redirect arrives well
    // before the cold-path OpenAI budget. 8 s leaves slack for slow
    // CI / Keycloak token-exchange round-trips while still being
    // comfortably below the ~15 s cold timing observed on the
    // reference stack.
    expect(cachedElapsedMs).toBeLessThan(8_000);

    // The cached view URL points at the same analysis row — same
    // host, same `/.../analysis` path, same identifying query
    // params (aice_id / event_key / lang / model_name / model). The
    // ephemeral `par_id` from the continue redirect can differ, so
    // compare the path + the cache-key params only.
    const samePath = (a: string, b: string): boolean => {
      const ua = new URL(a);
      const ub = new URL(b);
      if (ua.host !== ub.host || ua.pathname !== ub.pathname) return false;
      for (const k of ["lang", "model_name", "model"] as const) {
        if (ua.searchParams.get(k) !== ub.searchParams.get(k)) return false;
      }
      return true;
    };
    expect(samePath(cachedBridgeTab.url(), coldViewUrl)).toBe(true);
    await cachedBridgeTab.close();

    // ── Forced arm: ?aimerForce=1 → bypass cache, re-invoke aimer. ──
    // Navigate back to the event detail with the force flag armed.
    // The current URL is `/events/<token>`; append the query.
    const eventUrl = new URL(page.url());
    eventUrl.searchParams.set("aimerForce", "1");
    await page.goto(eventUrl.toString());
    await page.getByTestId("aimer-send-button").waitFor({ timeout: 15_000 });

    keycloakLoginFormHits = 0; // reset counter for this arm
    const [forcedBridgeTab] = await Promise.all([
      context.waitForEvent("page", { timeout: 30_000 }),
      (async () => {
        await page.getByTestId("aimer-send-button").click();
        await page.getByTestId("aimer-modal-send").click();
      })(),
    ]);
    await forcedBridgeTab.waitForURL(/\/analysis(\?|$)/, { timeout: 60_000 });

    // The forced arm should still complete silent SSO (no login form)
    // — the only thing that differs from the cached arm is that aimer
    // is re-invoked under the hood. Asserting on timing here would
    // be brittle (OpenAI latency is wide-tailed); the audit-trail
    // check in a follow-up commit can verify `cached: false,
    // force: true`.
    expect(keycloakLoginFormHits).toBe(0);

    // The URL param must be consumed (stripped) after the click so a
    // user who refreshes the original tab does not re-force.
    expect(page.url()).not.toContain("aimerForce=");

    context.off("request", onPopupRequest);
    await forcedBridgeTab.close();
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
    }) => {
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
