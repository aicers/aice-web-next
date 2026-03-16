import { expect, test } from "@playwright/test";

import { resetRateLimits } from "./helpers/auth";
import { resetAccountDefaults, revokeAllSessions } from "./helpers/setup-db";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Admin1234!";
const APP_URL = process.env.BASE_URL ?? "http://localhost:3000";

/**
 * Helper: sign in via the UI and wait until redirected away from sign-in.
 */
async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
  await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
}

/**
 * Helper: set the session monitor cookies to simulate near-expiry without
 * waiting for the server-issued JWT to age naturally.
 */
async function setSessionMonitorCookies(
  page: import("@playwright/test").Page,
  expSeconds: number,
  ttlSeconds = 15 * 60,
): Promise<void> {
  await page.context().addCookies([
    {
      name: "token_exp",
      value: String(expSeconds),
      url: APP_URL,
      sameSite: "Strict",
    },
    {
      name: "token_ttl",
      value: String(ttlSeconds),
      url: APP_URL,
      sameSite: "Strict",
    },
  ]);
}

test.describe("Session Extension Dialog", () => {
  test.beforeAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test.afterAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  // ── 1. Dialog appears when session nears expiry ───────────────

  test("dialog appears when JWT remaining ≤ 1/5 of lifetime", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 2 minutes from now (< 3 min threshold)
    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    // Wait for the session monitor to detect near-expiry (ticks every 1s)
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Verify dialog content
    await expect(
      dialog.getByText(/session is about to expire|세션이 곧 만료/i),
    ).toBeVisible();

    // Verify both buttons are present
    await expect(
      dialog.getByRole("button", { name: /stay signed in|로그인 유지/i }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /sign out|로그아웃/i }),
    ).toBeVisible();
  });

  // ── 2. Dialog does NOT appear when plenty of time ─────────────

  test("dialog does not appear when JWT has plenty of time remaining", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 10 minutes from now (well above 3 min threshold)
    const exp = Math.floor(Date.now() / 1000) + 600;
    await setSessionMonitorCookies(page, exp);

    // Wait a moment to give the monitor time to tick
    await page.waitForTimeout(2_000);

    // Dialog should NOT be visible
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).not.toBeVisible();
  });

  // ── 3. [Extend] click calls /api/auth/me and closes dialog ────

  test("clicking Extend calls /api/auth/me and closes the dialog", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 2 minutes from now
    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    // Wait for dialog to appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Intercept the /api/auth/me call to verify it happens
    const mePromise = page.waitForResponse(
      (res) => res.url().includes("/api/auth/me") && res.status() === 200,
    );

    // Click Extend
    await dialog
      .getByRole("button", { name: /stay signed in|로그인 유지/i })
      .click();

    // Verify /api/auth/me was called successfully
    const meResponse = await mePromise;
    expect(meResponse.ok()).toBeTruthy();

    // Dialog should close
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // User should still be on the dashboard (not redirected)
    await expect(page).not.toHaveURL(/sign-in/);
  });

  // ── 4. [Sign out] click signs out and redirects ───────────────

  test("clicking Sign Out signs out and redirects to sign-in", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 2 minutes from now
    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    // Wait for dialog to appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Click Sign Out
    await dialog.getByRole("button", { name: /sign out|로그아웃/i }).click();

    // Should redirect to sign-in page with ?reason=signed-out
    // (SessionExtensionDialog.handleSignOut calls router.push("/sign-in?reason=signed-out"))
    await expect(page).toHaveURL(/sign-in\?reason=signed-out/, {
      timeout: 10_000,
    });
  });

  // ── 5. Countdown expires → redirect ───────────────────────────

  test("when countdown reaches zero, user is redirected to sign-in", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 3 seconds from now — dialog appears, then expires
    const exp = Math.floor(Date.now() / 1000) + 3;
    await setSessionMonitorCookies(page, exp);

    // Dialog should appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Wait for expiry — should redirect to sign-in
    await expect(page).toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  // ── 6. Countdown display shows correct format ─────────────────

  test("dialog displays countdown in MM:SS format", async ({ page }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 90 seconds from now
    const exp = Math.floor(Date.now() / 1000) + 90;
    await setSessionMonitorCookies(page, exp);

    // Wait for dialog to appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Verify countdown format (MM:SS — should show something like 01:29 or 01:30)
    await expect(dialog.locator(".font-mono")).toHaveText(/^0[12]:\d{2}$/);
  });

  // ── 7. Dialog stays dismissed after extend ───────────────────

  test("dialog stays dismissed after extend even while near-expiry", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Set token_exp to 2 minutes from now
    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    // Wait for dialog to appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Click Extend
    await dialog
      .getByRole("button", { name: /stay signed in|로그인 유지/i })
      .click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Wait 2 more seconds — dialog should NOT reappear (same exp)
    await page.waitForTimeout(2_000);
    await expect(dialog).not.toBeVisible();
  });

  // ── 8. Rapid clicks on Extend only trigger one request ──────

  test("rapid double-click on Extend only triggers one /api/auth/me", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Collect all /api/auth/me requests
    const meRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/auth/me")) meRequests.push(req.url());
    });

    // Rapid double-click — button should disable after first click
    const extendBtn = dialog.getByRole("button", {
      name: /stay signed in|로그인 유지/i,
    });
    await extendBtn.dblclick();

    // Wait for the request to complete
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Only one request should have been sent
    expect(meRequests.length).toBe(1);
  });

  // ── 9. Sign-out works without CSRF cookie ───────────────────

  test("sign-out succeeds even when CSRF cookie is missing", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    // Delete CSRF cookies before triggering dialog
    await page.context().clearCookies({ name: "csrf" });
    await page.context().clearCookies({ name: "__Host-csrf" });

    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Click Sign Out — should still redirect despite missing CSRF
    await dialog.getByRole("button", { name: /sign out|로그아웃/i }).click();
    await expect(page).toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  // ── 10. i18n: dialog renders in Korean locale ──────────────────

  test("dialog renders correctly in Korean locale", async ({ page }) => {
    await revokeAllSessions(ADMIN_USERNAME);

    // Sign in via Korean locale
    await page.goto("/ko/sign-in");
    await page.getByLabel("계정 ID").fill(ADMIN_USERNAME);
    await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });

    // Set token_exp to 2 minutes from now
    const exp = Math.floor(Date.now() / 1000) + 120;
    await setSessionMonitorCookies(page, exp);

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Verify Korean text
    await expect(dialog.getByText(/세션이 곧 만료/)).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /로그인 유지/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /로그아웃/ }),
    ).toBeVisible();
  });

  test("dialog threshold follows the current JWT lifetime", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signIn(page);

    const dialog = page.getByRole("alertdialog");

    // For a 10-minute token, the dialog threshold is 2 minutes.
    await setSessionMonitorCookies(
      page,
      Math.floor(Date.now() / 1000) + 125,
      600,
    );
    await page.waitForTimeout(2_000);
    await expect(dialog).not.toBeVisible();

    await setSessionMonitorCookies(
      page,
      Math.floor(Date.now() / 1000) + 120,
      600,
    );
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(
      dialog.getByText(/session is about to expire|세션이 곧 만료/i),
    ).toBeVisible();
  });
});
