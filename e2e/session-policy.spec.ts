import { expect, test } from "./fixtures";

import { resetRateLimits } from "./helpers/auth";
import {
  expireSessionIdle,
  flagSessionReauth,
  getSessionStatus,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

/**
 * Helper: sign in via the UI and wait until redirected away from sign-in.
 */
async function signIn(
  page: import("@playwright/test").Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Account ID").fill(username);
  await page.locator("input[name='password']").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
}

/**
 * Helper: make an authenticated API call and return the response.
 */
async function callProtectedApi(
  page: import("@playwright/test").Page,
): Promise<import("@playwright/test").APIResponse> {
  return page.request.get("/api/auth/me");
}

test.describe("Session Policy E2E", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
  });

  test.afterAll(async ({ workerUsername }) => {
    await resetAccountDefaults(workerUsername);
  });

  // ── 1. Idle timeout → 401 ──────────────────────────────────────

  test("idle timeout expires session and returns 401", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Clean up and sign in
    await revokeAllSessions(workerUsername);
    await signIn(page, workerUsername, workerPassword);

    // Verify authenticated API works before expiring
    const beforeResponse = await callProtectedApi(page);
    expect(beforeResponse.ok()).toBeTruthy();

    // Expire the session idle timeout by setting last_active_at far in the past
    // Default idle timeout is 30 minutes, so we set 60 minutes ago
    await expireSessionIdle(workerUsername, 60);

    // Next API call should return 401 with SESSION_IDLE_TIMEOUT code
    const afterResponse = await callProtectedApi(page);
    expect(afterResponse.status()).toBe(401);

    const body = await afterResponse.json();
    expect(body.code).toBe("SESSION_IDLE_TIMEOUT");
  });

  // ── 2. IP change → re-auth required ───────────────────────────

  test("session flagged for re-auth blocks API calls with REAUTH_REQUIRED", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Clean up and sign in
    await revokeAllSessions(workerUsername);
    await signIn(page, workerUsername, workerPassword);

    // Verify authenticated API works
    const beforeResponse = await callProtectedApi(page);
    expect(beforeResponse.ok()).toBeTruthy();

    // Simulate IP/UA change detection by directly flagging the session
    // (In production, the guard would detect this via IP/UA comparison.
    //  Here we simulate the outcome by writing needs_reauth = true.)
    await flagSessionReauth(workerUsername);

    // Next API call should return 401 with REAUTH_REQUIRED code
    const afterResponse = await callProtectedApi(page);
    expect(afterResponse.status()).toBe(401);

    const body = await afterResponse.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
  });

  // ── 3. UA change → re-auth → password → session restore ──────

  test("re-auth with correct password restores session access", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Clean up and sign in
    await revokeAllSessions(workerUsername);
    await signIn(page, workerUsername, workerPassword);

    // Verify authenticated API works
    const beforeResponse = await callProtectedApi(page);
    expect(beforeResponse.ok()).toBeTruthy();

    // Flag the session for re-auth (simulating UA major change detection)
    await flagSessionReauth(workerUsername);

    // Verify the session is blocked
    const blockedResponse = await callProtectedApi(page);
    expect(blockedResponse.status()).toBe(401);
    const blockedBody = await blockedResponse.json();
    expect(blockedBody.code).toBe("REAUTH_REQUIRED");

    // Get CSRF token for POST request
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Call re-auth endpoint with correct password
    const reauthResponse = await page.request.post("/api/auth/reauth", {
      data: { password: workerPassword },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(reauthResponse.ok()).toBeTruthy();
    const reauthBody = await reauthResponse.json();
    expect(reauthBody.ok).toBe(true);

    // Verify session is restored: needs_reauth should be false now
    const sessionStatus = await getSessionStatus(workerUsername);
    expect(sessionStatus).not.toBeNull();
    expect(sessionStatus?.needsReauth).toBe(false);

    // API calls should work again
    const restoredResponse = await callProtectedApi(page);
    expect(restoredResponse.ok()).toBeTruthy();
  });

  test("re-auth with wrong password is rejected and session stays blocked", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Clean up and sign in
    await revokeAllSessions(workerUsername);
    await signIn(page, workerUsername, workerPassword);

    // Flag for re-auth
    await flagSessionReauth(workerUsername);

    // Get CSRF token
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Try re-auth with wrong password
    const reauthResponse = await page.request.post("/api/auth/reauth", {
      data: { password: "WrongPassword999!" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(reauthResponse.status()).toBe(401);
    const reauthBody = await reauthResponse.json();
    expect(reauthBody.error).toBe("Invalid password");

    // Session should still be blocked
    const sessionStatus = await getSessionStatus(workerUsername);
    expect(sessionStatus).not.toBeNull();
    expect(sessionStatus?.needsReauth).toBe(true);

    // API calls should still fail
    const stillBlockedResponse = await callProtectedApi(page);
    expect(stillBlockedResponse.status()).toBe(401);
  });
});
