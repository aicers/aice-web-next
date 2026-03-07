import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  createTestAccount,
  deleteTestAccount,
  resetAccountDefaults,
} from "./helpers/setup-db";

const MONITOR_USERNAME = "e2e-monitor";
const MONITOR_PASSWORD = "Monitor1234!";

test.describe("RBAC permission enforcement", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await createTestAccount(
      MONITOR_USERNAME,
      MONITOR_PASSWORD,
      "Security Monitor",
    );
  });

  test.afterAll(async () => {
    await deleteTestAccount(MONITOR_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("admin can access audit-logs API", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.get("/api/audit-logs");

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("total");
  });

  test("non-admin user gets 403 on audit-logs API", async ({ page }) => {
    await signInAndWait(page, MONITOR_USERNAME, MONITOR_PASSWORD);

    const response = await page.request.get("/api/audit-logs");

    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });
});
