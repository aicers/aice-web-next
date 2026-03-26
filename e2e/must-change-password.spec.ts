import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
import {
  clearMustChangePassword,
  resetAccountDefaults,
  setMustChangePassword,
  setPassword,
} from "./helpers/setup-db";

test.describe("Must-change-password flow", () => {
  test.beforeAll(async ({ workerUsername, workerPassword }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await setPassword(workerUsername, workerPassword);
    await setMustChangePassword(workerUsername, true);
  });

  test.afterAll(async ({ workerUsername, workerPassword }) => {
    await clearMustChangePassword(workerUsername);
    await setPassword(workerUsername, workerPassword);
    await resetAccountDefaults(workerUsername);
  });

  test("sign-in redirects to /change-password", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await page.waitForURL("**/change-password", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/change-password/);
  });

  test("API returns 403 while must_change_password is true", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // Attempt to access a protected API endpoint.
    const response = await page.request.get("/api/audit-logs");
    expect(response.status()).toBe(403);

    const body = await response.json();
    expect(body.redirect).toBe("/change-password");
  });

  test("sign-out still works when must_change_password is true", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // Sign out via API (should succeed despite must_change_password).
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const response = await page.request.post("/api/auth/sign-out", {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });
    expect(response.ok()).toBeTruthy();

    // Verify we're signed out: protected route redirects to sign-in.
    await page.goto("/audit-logs");
    await page.waitForURL("**/sign-in");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
