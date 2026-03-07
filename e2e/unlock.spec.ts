import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
  signOut,
} from "./helpers/auth";
import {
  createTestAccount,
  deleteTestAccount,
  getAccountId,
  resetAccountDefaults,
  setAccountStatus,
  setLockoutCount,
} from "./helpers/setup-db";

const MONITOR_USERNAME = "e2e-unlock-monitor";
const MONITOR_PASSWORD = "Monitor1234!";
const TARGET_USERNAME = "e2e-unlock-target";
const TARGET_PASSWORD = "Target1234!";

test.describe("Account unlock/restore API", () => {
  let targetAccountId: string;

  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await createTestAccount(
      MONITOR_USERNAME,
      MONITOR_PASSWORD,
      "Security Monitor",
    );
    await createTestAccount(
      TARGET_USERNAME,
      TARGET_PASSWORD,
      "Security Monitor",
    );
    targetAccountId = await getAccountId(TARGET_USERNAME);
  });

  test.afterAll(async () => {
    await deleteTestAccount(MONITOR_USERNAME);
    await deleteTestAccount(TARGET_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("admin can unlock a locked account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Get target account ID
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Lock the target account via DB
    await setAccountStatus(
      TARGET_USERNAME,
      "locked",
      new Date(Date.now() + 30 * 60_000),
    );
    await setLockoutCount(TARGET_USERNAME, 1);

    // Call unlock API
    const response = await page.request.post(
      `/api/accounts/${targetAccountId}/unlock`,
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, action: "unlocked" });

    await signOut(page);
  });

  test("admin can restore a suspended account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Suspend the target account
    await setAccountStatus(TARGET_USERNAME, "suspended", null);
    await setLockoutCount(TARGET_USERNAME, 2);

    const response = await page.request.post(
      `/api/accounts/${targetAccountId}/unlock`,
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, action: "restored" });

    await signOut(page);
  });

  test("restored account can sign in again", async ({ page }) => {
    // Target was just restored in the previous test
    await resetAccountDefaults(TARGET_USERNAME);

    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(TARGET_USERNAME);
    await page.locator("input[name='password']").fill(TARGET_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  test("non-admin cannot unlock accounts (403)", async ({ page }) => {
    await signInAndWait(page, MONITOR_USERNAME, MONITOR_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    await setAccountStatus(
      TARGET_USERNAME,
      "locked",
      new Date(Date.now() + 30 * 60_000),
    );

    const response = await page.request.post(
      `/api/accounts/${targetAccountId}/unlock`,
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(403);

    await signOut(page);
    await resetAccountDefaults(TARGET_USERNAME);
  });

  test("unlock returns 400 for active account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    await resetAccountDefaults(TARGET_USERNAME);

    const response = await page.request.post(
      `/api/accounts/${targetAccountId}/unlock`,
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Account is not locked or suspended");

    await signOut(page);
  });

  test("unlock returns 404 for non-existent account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post(
      "/api/accounts/00000000-0000-0000-0000-000000000000/unlock",
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(404);

    await signOut(page);
  });
});
