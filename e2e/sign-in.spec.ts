import { expect, test } from "@playwright/test";

const locales = ["en", "ko"] as const;

for (const locale of locales) {
  test(`sign-in flow works for ${locale}`, async ({ page }) => {
    await page.route("**/api/review/sign-in", async (route) => {
      const body = route.request().postDataJSON() as {
        username: string;
        password: string;
      };

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          token: `token-${body.username}`,
          expirationTime: "2030-01-01T00:00:00.000Z",
        }),
      });
    });

    await page.goto(`/${locale}/signin`);

    await page.getByTestId("signin-username").fill("playwright");
    await page.getByTestId("signin-password").fill("super-secret");
    await page.getByTestId("signin-submit").click();

    await expect(page.getByTestId("signin-token-container")).toContainText(
      "token-playwright",
    );
  });
}
