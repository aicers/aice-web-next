import { expect, test } from "@playwright/test";

import { resetRateLimits, signIn } from "./helpers/auth";

test.describe("Rate limiting — UI", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
  });

  test("per-account+IP: 429 after exceeding limit", async ({
    page,
    request,
  }) => {
    // The per-account+IP limit is 5 per 5 minutes.
    // Use a fake username so we don't trigger account lockout.
    const fakeUser = "ratelimit-acctip-test";

    // Submit 5 attempts via API (fast).
    for (let i = 0; i < 5; i++) {
      await request.post("/api/auth/sign-in", {
        data: { username: fakeUser, password: "wrong" },
      });
    }

    // 6th attempt via the UI form → should show rate-limit message.
    await page.goto("/sign-in");
    await signIn(page, fakeUser, "wrong");

    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(
      "Too many attempts. Please wait and try again.",
    );
  });
});
