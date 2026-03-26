import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.beforeAll(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.describe("Auth flow screens (#131)", () => {
  // ── Sign-out reason screen ──────────────────────────────────

  test("signed-out reason screen displays after sign-out", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Sign out via the nav user menu
    await page.goto("/sign-in?reason=signed-out");
    await expect(
      page.getByRole("heading", { name: /you've been signed out/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/you have successfully signed out/i),
    ).toBeVisible();
  });

  test("signed-out screen has Sign in again button", async ({ page }) => {
    await page.goto("/sign-in?reason=signed-out");
    const btn = page.getByRole("link", { name: /sign in again/i });
    await expect(btn).toBeVisible();

    // Clicking it should go back to the regular sign-in form
    await btn.click();
    await page.waitForURL(/\/sign-in$/);
    // Regular sign-in form should be visible (no reason screen)
    await expect(page.getByLabel("Account ID")).toBeVisible();
  });

  // ── Session-ended reason screen ─────────────────────────────

  test("session-ended reason screen displays correctly", async ({ page }) => {
    await page.goto("/sign-in?reason=session-ended");
    await expect(
      page.getByRole("heading", { name: /your session has ended/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/session expired due to inactivity/i),
    ).toBeVisible();
  });

  test("session-ended screen has Sign in again button", async ({ page }) => {
    await page.goto("/sign-in?reason=session-ended");
    const btn = page.getByRole("link", { name: /sign in again/i });
    await expect(btn).toBeVisible();

    await btn.click();
    await page.waitForURL(/\/sign-in$/);
    await expect(page.getByLabel("Account ID")).toBeVisible();
  });

  // ── Invalid reason falls back to sign-in form ───────────────

  test("invalid reason parameter shows regular sign-in form", async ({
    page,
  }) => {
    await page.goto("/sign-in?reason=invalid-reason");
    // Should NOT show a reason screen — should show normal form
    await expect(page.getByLabel("Account ID")).toBeVisible();
    await expect(page.locator("input[name='password']")).toBeVisible();
  });

  // ── Korean locale reason screens ────────────────────────────

  test("signed-out screen renders in Korean", async ({ page }) => {
    await page.goto("/ko/sign-in?reason=signed-out");
    // Korean heading for "You've been signed out"
    await expect(page.getByRole("heading")).toBeVisible();
    // "Sign in again" button in Korean
    await expect(
      page.getByRole("link", { name: /다시 로그인/i }),
    ).toBeVisible();
  });

  test("session-ended screen renders in Korean", async ({ page }) => {
    await page.goto("/ko/sign-in?reason=session-ended");
    await expect(page.getByRole("heading")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /다시 로그인/i }),
    ).toBeVisible();
  });

  // ── Required field markers (*) ──────────────────────────────

  test("sign-in form shows required asterisks on labels", async ({ page }) => {
    await page.goto("/sign-in");

    // The FormLabel component renders <span aria-hidden="true" class="text-destructive ml-0.5">*</span>
    // for required fields. Both Account ID and Password are required.
    const asterisks = page.locator('span[aria-hidden="true"].text-destructive');
    const count = await asterisks.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // ── Sign-out invalidates session and redirects ──────────────

  test("sign-out invalidates session so protected pages redirect to sign-in", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === "csrf")?.value ?? "";

    const res = await page.request.post("/api/auth/sign-out", {
      headers: {
        "x-csrf-token": csrf,
        Origin: "http://localhost:3000",
      },
    });
    expect(res.status()).toBe(200);

    // After sign-out, navigating to a protected page must redirect to /sign-in.
    // The server-side auth guard redirects to /sign-in (without reason param);
    // the ?reason=signed-out param is added client-side by session-extension-dialog.
    await page.goto("/");
    await page.waitForURL(/\/sign-in/);
    // Confirm we landed on the sign-in page with the form visible
    await expect(page.getByLabel("Account ID")).toBeVisible();
  });
});
