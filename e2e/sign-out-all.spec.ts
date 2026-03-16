import { expect, type Page, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
} from "./helpers/auth";
import {
  getSessionStatus,
  resetAccountDefaults,
  setMaxSessions,
} from "./helpers/setup-db";

const APP_URL = process.env.BASE_URL ?? "http://localhost:3000";
const APP_ORIGIN = APP_URL.replace("127.0.0.1", "localhost");

async function signInViaApi(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/sign-in", {
    headers: { "Content-Type": "application/json" },
    data: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    },
  });
  expect(response.ok()).toBeTruthy();
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
  test.beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.afterEach(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("sign-out-all invalidates other sessions", async ({ browser }) => {
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
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("sign-out-all clears active sessions so max_sessions does not block re-login", async ({
    page,
  }) => {
    await setMaxSessions(ADMIN_USERNAME, 1);
    await signInViaApi(page);

    expect(await getSessionStatus(ADMIN_USERNAME)).not.toBeNull();

    await signOutAllViaApi(page);

    await expect
      .poll(async () => (await getSessionStatus(ADMIN_USERNAME)) === null)
      .toBe(true);

    await signInViaApi(page);

    await expect
      .poll(async () => (await getSessionStatus(ADMIN_USERNAME)) !== null)
      .toBe(true);
  });
});
