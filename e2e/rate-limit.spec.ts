import { expect, test } from "@playwright/test";

import { resetRateLimits, signIn } from "./helpers/auth";

test.describe("Rate limiting", () => {
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

  test("per-IP: 429 after exhausting per-IP bucket", async ({ request }) => {
    // Reset counters to start clean.
    await resetRateLimits();

    // The per-IP limit is 20 per 5 minutes.
    // Use different fake usernames (5 attempts each) to stay under
    // the per-account+IP limit of 5 while building up the per-IP count.
    for (let batch = 0; batch < 4; batch++) {
      const user = `ratelimit-ip-test-${batch}`;
      for (let i = 0; i < 5; i++) {
        await request.post("/api/auth/sign-in", {
          data: { username: user, password: "wrong" },
        });
      }
    }

    // per-IP count is now 20. The next request should be rate-limited.
    const response = await request.post("/api/auth/sign-in", {
      data: { username: "ratelimit-ip-final", password: "wrong" },
    });

    expect(response.status()).toBe(429);
  });
});
