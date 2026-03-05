import { expect, test } from "@playwright/test";

import { resetRateLimits } from "./helpers/auth";
import { clearMustChangePassword, revokeAllSessions } from "./helpers/setup-db";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Admin1234!";

test.describe("Authentication E2E", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test("unauthenticated access to protected route redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("/audit-logs");
    await page.waitForURL("**/sign-in");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("/ko/sign-in renders Korean labels", async ({ page }) => {
    await page.goto("/ko/sign-in");

    await expect(
      page.getByRole("heading", { name: "계정에 로그인" }),
    ).toBeVisible();
    await expect(page.getByLabel("계정 ID")).toBeVisible();
    // Password label check via locator — FormControl wraps input in a
    // <div> so getByLabel cannot resolve the <input> directly.
    await expect(page.locator("label", { hasText: "비밀번호" })).toBeVisible();
    await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
  });

  test("sign-in with invalid credentials shows error message", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
    await page.locator("input[name='password']").fill("WrongPassword123!");
    await page.getByRole("button", { name: "Sign In" }).click();

    // Use p[role='alert'] to exclude Next.js route announcer <div>
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Invalid account ID or password");
  });

  test("sign-in with valid credentials redirects to dashboard", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
    await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  test("sign-out clears session and redirects to sign-in", async ({ page }) => {
    // Sign in first
    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
    await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });

    // Sign out via API (NavUser button not wired yet).
    // The endpoint requires CSRF token + Origin header.
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const response = await page.request.post("/api/auth/sign-out", {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });
    expect(response.ok()).toBeTruthy();

    // Protected route should redirect to sign-in
    await page.goto("/audit-logs");
    await page.waitForURL("**/sign-in");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
