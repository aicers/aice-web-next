import type { Page } from "@playwright/test";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "Admin1234!";

const BASE_URL = "http://localhost:3000";

/**
 * Reset the in-memory rate limiter via the test-only API endpoint.
 * Uses `fetch()` directly so it works in `test.beforeAll` (where the
 * Playwright `request` fixture has no baseURL).
 */
export async function resetRateLimits(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/e2e/reset-rate-limits`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`reset-rate-limits failed: ${res.status}`);
}

/**
 * Fill the sign-in form and submit. Does NOT wait for a specific
 * outcome — callers should assert the expected result.
 */
export async function signIn(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.getByLabel("Account ID").fill(username);
  await page.locator("input[name='password']").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

/**
 * Korean variant of signIn — navigates to /ko/sign-in first.
 */
export async function signInKo(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/ko/sign-in");
  await page.getByLabel("계정 ID").fill(username);
  await page.locator("input[name='password']").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

/**
 * Sign out via API using the CSRF cookie from the current page context.
 */
export async function signOut(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const csrfCookie = cookies.find((c) => c.name === "csrf");
  await page.request.post("/api/auth/sign-out", {
    headers: {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: "http://localhost:3000",
    },
  });
}

/**
 * Full sign-in flow: navigate to /sign-in, fill form, wait for redirect.
 */
export async function signInAndWait(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await signIn(page, username, password);
  await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
    timeout: 10_000,
  });
}
