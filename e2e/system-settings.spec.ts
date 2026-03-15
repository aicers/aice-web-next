import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";

// ── Helpers ───────────────────────────────────────────────────

const READER_USER = "e2e-settings-reader";
const READER_PASS = "Reader1234!";
const READER_ROLE = "E2E Settings Reader";

function csrfHeader(csrfValue: string) {
  return {
    "x-csrf-token": csrfValue,
    Origin: "http://localhost:3000",
    "Content-Type": "application/json",
  };
}

async function getCsrf(page: import("@playwright/test").Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf")?.value ?? "";
}

// ── Setup / Teardown ──────────────────────────────────────────

test.beforeAll(async () => {
  await resetRateLimits();
  // Create a role with read-only settings permission (no write)
  await createTestRole(READER_ROLE, ["system-settings:read"]);
  await createTestAccount(READER_USER, READER_PASS, READER_ROLE);
});

test.beforeEach(async () => {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
});

test.afterAll(async () => {
  await deleteTestAccount(READER_USER);
  await deleteTestRole(READER_ROLE);
});

// ── API Tests ─────────────────────────────────────────────────

test.describe("System settings", () => {
  test("GET /api/system-settings returns all settings", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await page.request.get("/api/system-settings");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);

    // Should contain known setting keys
    const keys = body.data.map((s: { key: string }) => s.key);
    expect(keys).toContain("password_policy");
    expect(keys).toContain("session_policy");
    expect(keys).toContain("lockout_policy");
    expect(keys).toContain("jwt_policy");
    expect(keys).toContain("mfa_policy");
  });

  test("GET /api/system-settings returns 403 without permission", async ({
    page,
  }) => {
    // Sign in as a user with no settings permission
    await resetAccountDefaults(READER_USER);
    // Create a no-perm role
    await createTestRole("E2E No Perms", []);
    await createTestAccount("e2e-noperm", "NoPerm1234!", "E2E No Perms");
    try {
      await signInAndWait(page, "e2e-noperm", "NoPerm1234!");
      const res = await page.request.get("/api/system-settings");
      expect(res.status()).toBe(403);
    } finally {
      await deleteTestAccount("e2e-noperm");
      await deleteTestRole("E2E No Perms");
    }
  });

  test("PATCH /api/system-settings/[key] updates a setting", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const csrf = await getCsrf(page);

    // Read current value first
    const getRes = await page.request.get("/api/system-settings");
    const allSettings = await getRes.json();
    const jwtSetting = allSettings.data.find(
      (s: { key: string }) => s.key === "jwt_policy",
    );
    const originalValue = jwtSetting.value.access_token_expiration_minutes;

    // Update to a different value
    const newValue = originalValue === 15 ? 20 : 15;
    try {
      const patchRes = await page.request.patch(
        "/api/system-settings/jwt_policy",
        {
          headers: csrfHeader(csrf),
          data: { value: { access_token_expiration_minutes: newValue } },
        },
      );
      expect(patchRes.status()).toBe(200);

      // Verify the update persisted
      const verifyRes = await page.request.get("/api/system-settings");
      const updated = await verifyRes.json();
      const updatedJwt = updated.data.find(
        (s: { key: string }) => s.key === "jwt_policy",
      );
      expect(updatedJwt.value.access_token_expiration_minutes).toBe(newValue);
    } finally {
      // Restore original value even if assertions fail
      await page.request.patch("/api/system-settings/jwt_policy", {
        headers: csrfHeader(csrf),
        data: { value: { access_token_expiration_minutes: originalValue } },
      });
    }
  });

  test("PATCH rejects invalid values with 400", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const csrf = await getCsrf(page);

    const res = await page.request.patch(
      "/api/system-settings/password_policy",
      {
        headers: csrfHeader(csrf),
        data: { value: { min_length: 3 } }, // below minimum of 8
      },
    );
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test("PATCH rejects unknown setting key with 400", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const csrf = await getCsrf(page);

    const res = await page.request.patch(
      "/api/system-settings/nonexistent_key",
      {
        headers: csrfHeader(csrf),
        data: { value: { foo: "bar" } },
      },
    );
    expect(res.status()).toBe(400);
  });

  test("PATCH requires system-settings:write permission", async ({ page }) => {
    // Reader has system-settings:read but not :write
    await resetAccountDefaults(READER_USER);
    await signInAndWait(page, READER_USER, READER_PASS);
    const csrf = await getCsrf(page);

    const res = await page.request.patch("/api/system-settings/jwt_policy", {
      headers: csrfHeader(csrf),
      data: { value: { access_token_expiration_minutes: 10 } },
    });
    expect(res.status()).toBe(403);
  });

  // ── UI Tests ──────────────────────────────────────────────────

  test("settings page displays all tabs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/system");

    // Verify all six tabs are visible
    await expect(page.getByRole("tab", { name: /password/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /session/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /lockout/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /jwt/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /mfa/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /rate limits/i })).toBeVisible();
  });

  test("tab switching shows different form fields", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/system");

    // Password tab is default — should show min_length
    await expect(page.locator("#min_length")).toBeVisible();

    // Switch to Session tab
    await page.getByRole("tab", { name: /session/i }).click();
    await expect(page.locator("#idle_timeout_minutes")).toBeVisible();

    // Switch to JWT tab
    await page.getByRole("tab", { name: /jwt/i }).click();
    await expect(
      page.locator("#access_token_expiration_minutes"),
    ).toBeVisible();
  });

  test("read-only user sees disabled fields and info banner", async ({
    page,
  }) => {
    await resetAccountDefaults(READER_USER);
    await signInAndWait(page, READER_USER, READER_PASS);
    await page.goto("/settings/system");

    // Read-only notice should be visible
    await expect(
      page.getByText(/do not have permission to modify/i),
    ).toBeVisible();

    // Fields should be disabled
    const minLength = page.locator("#min_length");
    await expect(minLength).toBeDisabled();
  });

  test("settings update via UI persists", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/system");

    // Switch to JWT tab
    await page.getByRole("tab", { name: /jwt/i }).click();

    const input = page.locator("#access_token_expiration_minutes");
    await expect(input).toBeVisible();

    // Read current value and change it
    const currentValue = await input.inputValue();
    const newValue = currentValue === "15" ? "20" : "15";

    try {
      await input.fill(newValue);
      // Find the save button within the JWT tab panel
      await page.getByRole("button", { name: /jwt|save/i }).click();

      // Wait for success message
      await expect(page.getByText(/updated successfully/i)).toBeVisible({
        timeout: 5000,
      });

      // Reload and verify persistence
      await page.reload();
      await page.getByRole("tab", { name: /jwt/i }).click();
      await expect(input).toHaveValue(newValue);
    } finally {
      // Restore original value even if assertions fail
      await input.fill(currentValue);
      await page.getByRole("button", { name: /jwt|save/i }).click();
      await expect(page.getByText(/updated successfully/i)).toBeVisible({
        timeout: 5000,
      });
    }
  });

  // ── Audit Test ────────────────────────────────────────────────

  test("settings update appears in audit logs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    const csrf = await getCsrf(page);

    // Record the newest audit log ID before the change so we can
    // identify entries created by this test, not by earlier tests.
    const beforeRes = await page.request.get(
      "/api/audit-logs?action=system_settings.update&targetId=lockout_policy&pageSize=1",
    );
    const beforeBody = await beforeRes.json();
    const newestIdBefore =
      beforeBody.data.length > 0 ? beforeBody.data[0].id : null;

    // Make a settings change via API — send the full value object
    // because the validator requires all fields.
    const getRes = await page.request.get("/api/system-settings");
    const allSettings = await getRes.json();
    const lockoutSetting = allSettings.data.find(
      (s: { key: string }) => s.key === "lockout_policy",
    );
    const originalValue = { ...lockoutSetting.value };
    const updatedValue = {
      ...originalValue,
      stage1_threshold: originalValue.stage1_threshold === 5 ? 6 : 5,
    };

    try {
      const patchRes = await page.request.patch(
        "/api/system-settings/lockout_policy",
        {
          headers: csrfHeader(csrf),
          data: { value: updatedValue },
        },
      );
      expect(patchRes.status()).toBe(200);

      // The newest audit entry must be different from the one before
      // and must reference the key we just changed.
      // Use targetId filter to precisely match our change.
      const afterRes = await page.request.get(
        "/api/audit-logs?action=system_settings.update&targetId=lockout_policy&pageSize=1",
      );
      expect(afterRes.status()).toBe(200);
      const afterBody = await afterRes.json();
      expect(afterBody.data.length).toBeGreaterThan(0);

      const newest = afterBody.data[0];
      expect(newest.id).not.toBe(newestIdBefore);
      expect(newest.action).toBe("system_settings.update");
      expect(newest.target_id).toBe("lockout_policy");
    } finally {
      // Restore even if assertions fail
      await page.request.patch("/api/system-settings/lockout_policy", {
        headers: csrfHeader(csrf),
        data: { value: originalValue },
      });
    }
  });
});
