import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetRateLimits } from "./helpers/auth";
import {
  getSessionStatus,
  resetAccountDefaults,
  setMaxSessions,
} from "./helpers/setup-db";

const APP_URL = process.env.BASE_URL ?? "http://localhost:3000";
// Next.js local CSRF origin checks still expect the canonical localhost
// origin even when Playwright targets the app over 127.0.0.1.
const APP_ORIGIN = APP_URL.replace("127.0.0.1", "localhost");

function makeSignInViaApi(username: string, password: string) {
  return async (page: Page): Promise<void> => {
    const response = await page.request.post("/api/auth/sign-in", {
      headers: { "Content-Type": "application/json" },
      data: {
        username,
        password,
      },
    });
    expect(response.ok()).toBeTruthy();
  };
}

async function signOutAllViaApi(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "csrf");
  const response = await page.request.post("/api/auth/sign-out-all", {
    headers: {
      "x-csrf-token": csrf?.value ?? "",
      Origin: APP_ORIGIN,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test.describe("Sign-out-all", () => {
  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
  });

  test.afterEach(async ({ workerUsername }) => {
    await resetAccountDefaults(workerUsername);
  });

  test("sign-out-all invalidates other sessions", async ({
    browser,
    workerUsername,
    workerPassword,
  }) => {
    const signInViaApi = makeSignInViaApi(workerUsername, workerPassword);
    // Create two independent browser contexts (separate cookie jars).
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await signInViaApi(pageA);
      await signInViaApi(pageB);
      await signOutAllViaApi(pageA);

      // Context B should be invalidated: API call should return 401
      // because the server-side guard checks session existence in the DB.
      const apiResponse = await pageB.request.get("/api/audit-logs");
      expect(apiResponse.status()).toBe(401);

      // Protected page navigation should also redirect through the
      // dashboard layout guard once the DB-backed session is gone.
      await pageB.goto("/ko/audit-logs");
      await expect(pageB).toHaveURL(/\/ko\/sign-in$/, { timeout: 10_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("sign-out-all clears active sessions so max_sessions does not block re-login", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const signInViaApi = makeSignInViaApi(workerUsername, workerPassword);
    await setMaxSessions(workerUsername, 1);
    await signInViaApi(page);

    expect(await getSessionStatus(workerUsername)).not.toBeNull();

    await signOutAllViaApi(page);

    await expect.poll(async () => getSessionStatus(workerUsername)).toBeNull();

    await signInViaApi(page);

    await expect
      .poll(async () => getSessionStatus(workerUsername))
      .not.toBeNull();
  });
});
