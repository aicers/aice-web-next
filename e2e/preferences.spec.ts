import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  resetAccountDefaults,
  resetAccountPreferences,
  revokeAllSessions,
} from "./helpers/setup-db";

// ── DB helpers ────────────────────────────────────────────────

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found
  }
  return "postgres://postgres:postgres@localhost:5432/auth_db";
}

async function setAccountLocale(
  username: string,
  locale: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    await client.query("UPDATE accounts SET locale = $2 WHERE username = $1", [
      username,
      locale,
    ]);
  } finally {
    await client.end();
  }
}

async function setAccountTimezone(
  username: string,
  timezone: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET timezone = $2 WHERE username = $1",
      [username, timezone],
    );
  } finally {
    await client.end();
  }
}

// ── Tests ─────────────────────────────────────────────────────

test.describe("Preferences", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
    await resetAccountPreferences(ADMIN_USERNAME);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
    await resetAccountPreferences(ADMIN_USERNAME);
  });

  // ── API tests ─────────────────────────────────────────────────

  test("GET returns null when preferences are not set", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const res = await page.request.get("/api/accounts/me/preferences");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.locale).toBeNull();
    expect(body.data.timezone).toBeNull();
  });

  test("PATCH sets locale and NEXT_LOCALE cookie", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.locale).toBe("ko");

    // Verify NEXT_LOCALE cookie is set
    const updatedCookies = await page.context().cookies();
    const localeCookie = updatedCookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeDefined();
    expect(localeCookie?.value).toBe("ko");
  });

  test("PATCH sets timezone", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "Asia/Seoul" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.timezone).toBe("Asia/Seoul");
  });

  test("PATCH sets both locale and timezone simultaneously", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko", timezone: "Asia/Seoul" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.locale).toBe("ko");
    expect(body.data.timezone).toBe("Asia/Seoul");
  });

  test("PATCH rejects invalid locale", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "xx" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid timezone", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "Not/A/Zone" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(400);
  });

  test("PATCH null locale deletes NEXT_LOCALE cookie", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // First set locale
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Then clear it
    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: null },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(res.status()).toBe(200);
    expect((await res.json()).data.locale).toBeNull();

    // NEXT_LOCALE cookie should be deleted
    const updatedCookies = await page.context().cookies();
    const localeCookie = updatedCookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeUndefined();
  });

  test("GET returns updated values after PATCH", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Set preferences
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko", timezone: "America/New_York" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Read them back
    const res = await page.request.get("/api/accounts/me/preferences");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.locale).toBe("ko");
    expect(body.data.timezone).toBe("America/New_York");
  });

  test("unauthenticated request returns 401", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3000/api/accounts/me/preferences",
    );
    // withAuth redirects or returns 401/403
    expect([401, 403, 302]).toContain(res.status());
  });

  // ── Sign-in locale cookie ────────────────────────────────────

  test("sign-in sets NEXT_LOCALE cookie when account has stored locale", async ({
    page,
  }) => {
    await setAccountLocale(ADMIN_USERNAME, "ko");

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const localeCookie = cookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeDefined();
    expect(localeCookie?.value).toBe("ko");
  });

  test("sign-in does not set NEXT_LOCALE cookie when locale is null", async ({
    page,
  }) => {
    await resetAccountPreferences(ADMIN_USERNAME);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const localeCookie = cookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeUndefined();
  });

  // ── UI tests ──────────────────────────────────────────────────

  test("profile page shows preferences form", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/profile");

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByText("Language")).toBeVisible();
    await expect(page.getByLabel("Timezone")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  test("profile page displays stored preferences on load", async ({ page }) => {
    // Pre-set preferences in DB
    await setAccountLocale(ADMIN_USERNAME, "ko");
    await setAccountTimezone(ADMIN_USERNAME, "Asia/Seoul");

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/profile");

    // Form should show stored values
    await expect(page.getByRole("combobox").first()).toHaveText("한국어", {
      timeout: 5_000,
    });
  });

  test("locale change via UI switches page language to Korean", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/profile");

    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

    // Select Korean locale
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "한국어" }).click();

    // Save
    await page.getByRole("button", { name: "Save" }).click();

    // Wait for success message
    await expect(page.getByText("Preferences saved")).toBeVisible({
      timeout: 5_000,
    });

    // After router.refresh(), the page should switch to Korean
    // Wait for Korean labels to appear
    await expect(page.getByRole("heading", { name: "프로필" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByLabel("언어")).toBeVisible();
    await expect(page.getByLabel("시간대")).toBeVisible();
  });

  test("locale change persists after page reload", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Set Korean via API
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Reload the profile page
    await page.goto("/profile");

    // Should still show Korean
    await expect(page.getByRole("combobox").first()).toHaveText("한국어", {
      timeout: 5_000,
    });
  });

  test("timezone preference persists after page reload", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Set timezone via API
    await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "America/New_York" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Verify via GET
    const res = await page.request.get("/api/accounts/me/preferences");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.timezone).toBe("America/New_York");
  });

  // ── Timezone display integration ────────────────────────────────

  test("audit log timestamps reflect timezone preference", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const csrfHeader = {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: "http://localhost:3000",
    };

    // Set timezone to America/New_York and load audit logs
    await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "America/New_York" },
      headers: csrfHeader,
    });
    await page.goto("/audit-logs");

    // Wait for the table to render and capture the first timestamp
    const firstTimestamp = page.locator(
      "table tbody tr:first-child td:first-child",
    );
    await expect(firstTimestamp).toBeVisible({ timeout: 10_000 });
    const timestampNY = await firstTimestamp.textContent();

    // Switch to Asia/Seoul (16–17 hours ahead of NY)
    await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "Asia/Seoul" },
      headers: csrfHeader,
    });
    await page.reload();

    await expect(firstTimestamp).toBeVisible({ timeout: 10_000 });
    const timestampSeoul = await firstTimestamp.textContent();

    // The same underlying UTC timestamp should display differently
    expect(timestampNY).toBeTruthy();
    expect(timestampSeoul).toBeTruthy();
    expect(timestampNY).not.toBe(timestampSeoul);
  });
});
