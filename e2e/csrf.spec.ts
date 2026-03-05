import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.describe("CSRF protection", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("POST without x-csrf-token header returns 403", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.post("/api/auth/sign-out", {
      headers: {
        Origin: "http://localhost:3000",
        // Deliberately omit x-csrf-token
      },
    });

    expect(response.status()).toBe(403);
  });

  test("POST with wrong CSRF token returns 403", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.post("/api/auth/sign-out", {
      headers: {
        "x-csrf-token": "invalid-token-value",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(403);
  });

  test("POST without Origin header returns 403", async ({
    page,
    playwright,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Extract cookies from the authenticated context.
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const atCookie = cookies.find((c) => c.name === "at");

    // Create a standalone API context without automatic Origin.
    const apiContext = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      extraHTTPHeaders: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Cookie: `at=${atCookie?.value ?? ""}; csrf=${csrfCookie?.value ?? ""}`,
        // Deliberately omit Origin
      },
    });

    try {
      const response = await apiContext.post("/api/auth/sign-out");
      expect(response.status()).toBe(403);
    } finally {
      await apiContext.dispose();
    }
  });
});
