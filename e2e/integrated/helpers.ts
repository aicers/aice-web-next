import type { Page } from "@playwright/test";

export const ADMIN_USERNAME = process.env.INIT_ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD = process.env.INIT_ADMIN_PASSWORD ?? "Admin1234!";

/**
 * Keycloak test user for the OIDC interactive sign-in scenarios. Defaults
 * match the seeded realm-export.json on the reference multi-host stack;
 * override via env when the operator's compose seeds a different account.
 */
export const KEYCLOAK_USERNAME = process.env.KEYCLOAK_TEST_USERNAME ?? "tester";
export const KEYCLOAK_PASSWORD =
  process.env.KEYCLOAK_TEST_PASSWORD ?? "Tester1234!";

/**
 * Sign in to aice-web-next via the production sign-in surface (no
 * dev-only `/api/e2e/*` endpoints — this harness targets the prod build
 * running behind nginx). Mirrors `e2e/helpers/auth.ts` but skips the
 * rate-limit reset (no test endpoints available in prod).
 */
export async function signInAdmin(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
  await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
    timeout: 30_000,
  });
}

export const AICE_WEB_NEXT_URL =
  process.env.AICE_WEB_NEXT_URL ??
  "https://001.aice-web-next.aiceweb-host.test.local:9443";

export const AIMER_WEB_URL =
  process.env.AIMER_WEB_URL ??
  "https://001.aimer-web.aimer-web-host.test.local:19443";
