import { expect, test } from "./fixtures";

import { resetRateLimits } from "./helpers/auth";
import { clearMustChangePassword, revokeAllSessions } from "./helpers/setup-db";

test.describe("Authentication E2E", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await clearMustChangePassword(workerUsername);
    await revokeAllSessions(workerUsername);
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
    workerUsername,
  }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(workerUsername);
    await page.locator("input[name='password']").fill("WrongPassword123!");
    await page.getByRole("button", { name: "Sign In" }).click();

    // Use p[role='alert'] to exclude Next.js route announcer <div>
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Invalid account ID or password");
  });
});
