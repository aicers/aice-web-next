import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signIn,
} from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.describe("Sign-out-all", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("sign-out-all invalidates other sessions", async ({ browser }) => {
    // Create two independent browser contexts (separate cookie jars).
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      // Sign in on context A.
      await pageA.goto("http://localhost:3000/sign-in");
      await signIn(pageA, ADMIN_USERNAME, ADMIN_PASSWORD);
      await expect(pageA).not.toHaveURL(/sign-in/, { timeout: 10_000 });

      // Sign in on context B.
      await pageB.goto("http://localhost:3000/sign-in");
      await signIn(pageB, ADMIN_USERNAME, ADMIN_PASSWORD);
      await expect(pageB).not.toHaveURL(/sign-in/, { timeout: 10_000 });

      // From context A: call sign-out-all.
      const cookiesA = await contextA.cookies();
      const csrfA = cookiesA.find((c) => c.name === "csrf");
      const response = await pageA.request.post("/api/auth/sign-out-all", {
        headers: {
          "x-csrf-token": csrfA?.value ?? "",
          Origin: "http://localhost:3000",
        },
      });
      expect(response.ok()).toBeTruthy();

      // Context B should be invalidated: API call should return 401
      // because the server-side guard checks session existence in the DB.
      // (The proxy only does stateless JWT verification, so page navigation
      // still succeeds – but the API guard catches revoked sessions.)
      const apiResponse = await pageB.request.get(
        "http://localhost:3000/api/audit-logs",
      );
      expect(apiResponse.status()).toBe(401);

      // Protected page navigation should also redirect to localized sign-in
      // because the dashboard layout now rejects invalidated DB sessions.
      await pageB.goto("http://localhost:3000/ko/audit-logs");
      await expect(pageB).toHaveURL(/\/ko\/sign-in$/, { timeout: 10_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
