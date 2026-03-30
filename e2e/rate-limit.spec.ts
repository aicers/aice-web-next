import { expect, test } from "@playwright/test";

import { resetRateLimits, signIn } from "./helpers/auth";

test.describe("Rate limiting — UI", () => {
  test("per-account+IP: 429 after exceeding limit", async ({ page }) => {
    // Reset inside the test (not beforeAll) so no other serial worker
    // can fill buckets between the reset and our seed attempts.
    await resetRateLimits();

    // The per-account+IP limit is 5 per 5 minutes.
    // Use a fake username so we don't trigger account lockout.
    const fakeUser = "ratelimit-acctip-test";

    // Submit 5 attempts via page.request (shares the browser's IP,
    // unlike the standalone `request` fixture which may resolve to
    // a different loopback address — e.g. 127.0.0.1 vs ::1).
    for (let i = 0; i < 5; i++) {
      await page.request.post("/api/auth/sign-in", {
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
