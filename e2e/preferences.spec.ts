import { expect, test } from "./fixtures";
import { APP_ORIGIN, APP_URL } from "./helpers/app-url";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  clearMustChangePassword,
  deleteWebAuthnCredentials,
  insertWebAuthnCredential,
  resetAccountDefaults,
  resetAccountPreferences,
  revokeAllSessions,
  setAccountLocale,
  setAccountTimezone,
} from "./helpers/setup-db";

// ── Tests ─────────────────────────────────────────────────────

test.describe("Preferences", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetAccountPreferences(workerUsername);
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await revokeAllSessions(workerUsername);
    await resetAccountPreferences(workerUsername);
  });

  // ── API tests ─────────────────────────────────────────────────

  test("GET returns null when preferences are not set", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const res = await page.request.get("/api/accounts/me/preferences");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.locale).toBeNull();
    expect(body.data.timezone).toBeNull();
  });

  test("PATCH sets locale and NEXT_LOCALE cookie", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
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

  test("PATCH sets timezone", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "Asia/Seoul" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.timezone).toBe("Asia/Seoul");
  });

  test("PATCH sets both locale and timezone simultaneously", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko", timezone: "Asia/Seoul" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.locale).toBe("ko");
    expect(body.data.timezone).toBe("Asia/Seoul");
  });

  test("PATCH rejects invalid locale", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "xx" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid timezone", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { timezone: "Not/A/Zone" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    expect(res.status()).toBe(400);
  });

  test("PATCH null locale deletes NEXT_LOCALE cookie", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // First set locale
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    // Then clear it
    const res = await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: null },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    expect(res.status()).toBe(200);
    expect((await res.json()).data.locale).toBeNull();

    // NEXT_LOCALE cookie should be deleted
    const updatedCookies = await page.context().cookies();
    const localeCookie = updatedCookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeUndefined();
  });

  test("GET returns updated values after PATCH", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Set preferences
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko", timezone: "America/New_York" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
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
    const res = await request.get(`${APP_URL}/api/accounts/me/preferences`);
    // withAuth redirects or returns 401/403
    expect([401, 403, 302]).toContain(res.status());
  });

  // ── Sign-in locale cookie ────────────────────────────────────

  test("sign-in sets NEXT_LOCALE cookie when account has stored locale", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountLocale(workerUsername, "ko");

    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const localeCookie = cookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeDefined();
    expect(localeCookie?.value).toBe("ko");
  });

  test("sign-in does not set NEXT_LOCALE cookie when locale is null", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountPreferences(workerUsername);

    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const localeCookie = cookies.find((c) => c.name === "NEXT_LOCALE");
    expect(localeCookie).toBeUndefined();
  });

  // ── UI tests ──────────────────────────────────────────────────

  test("profile page shows preferences form", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByText("Language")).toBeVisible();
    await expect(page.getByLabel("Timezone", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  test("profile page displays stored preferences on load", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Pre-set preferences in DB
    await setAccountLocale(workerUsername, "ko");
    await setAccountTimezone(workerUsername, "Asia/Seoul");

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    // Form should show stored values
    await expect(page.getByRole("combobox").first()).toHaveText("한국어", {
      timeout: 5_000,
    });
  });

  test("locale change via UI switches page language to Korean", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
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
    await expect(page.getByLabel("시간대", { exact: true })).toBeVisible();
  });

  test("locale change persists after page reload", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Set Korean via API
    await page.request.patch("/api/accounts/me/preferences", {
      data: { locale: "ko" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: APP_ORIGIN,
      },
    });

    // Reload the profile page
    await page.goto("/profile");

    // Should still show Korean
    await expect(page.getByRole("combobox").first()).toHaveText("한국어", {
      timeout: 5_000,
    });
  });

  // ── Timezone display integration ────────────────────────────────

  test("audit log timestamps reflect timezone preference", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const csrfHeader = {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: APP_ORIGIN,
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

  // ── Time-display format (#766) ───────────────────────────────────

  test("GET returns null time-format fields when unset", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const res = await page.request.get("/api/accounts/me/preferences");
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.timeFormatLocale).toBeNull();
    expect(body.data.timeFormatHourCycle).toBeNull();
    expect(body.data.timeFormatSeconds).toBeNull();
    expect(body.data.timeFormatTzLabel).toBeNull();
  });

  test("PATCH persists the four time-format fields and GET reads them back", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const headers = {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: APP_ORIGIN,
    };

    const patch = await page.request.patch("/api/accounts/me/preferences", {
      data: {
        timeFormatLocale: "fr-CA",
        timeFormatHourCycle: "h23",
        timeFormatSeconds: false,
        timeFormatTzLabel: true,
      },
      headers,
    });
    expect(patch.status()).toBe(200);

    const res = await page.request.get("/api/accounts/me/preferences");
    const body = await res.json();
    expect(body.data.timeFormatLocale).toBe("fr-CA");
    expect(body.data.timeFormatHourCycle).toBe("h23");
    expect(body.data.timeFormatSeconds).toBe(false);
    expect(body.data.timeFormatTzLabel).toBe(true);
  });

  test("PATCH rejects invalid time-format values", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const headers = {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: APP_ORIGIN,
    };

    for (const data of [
      { timeFormatLocale: "xx-YY" },
      { timeFormatHourCycle: "h11" },
      { timeFormatSeconds: "yes" },
      { timeFormatTzLabel: 1 },
    ]) {
      const res = await page.request.patch("/api/accounts/me/preferences", {
        data,
        headers,
      });
      expect(res.status(), JSON.stringify(data)).toBe(400);
    }
  });

  test("profile page shows the time-format section with a live preview", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: "Time format" }),
    ).toBeVisible({ timeout: 5_000 });

    const preview = page.locator('[data-slot="time-format-preview"]');
    await expect(preview).toBeVisible();
    const before = await preview.textContent();

    // Switching to 24-hour changes the preview live (no save / reload).
    await page.locator("#tf-hour-cycle").click();
    await page.getByRole("option", { name: "24-hour" }).click();

    await expect(preview).not.toHaveText(before ?? "", { timeout: 5_000 });
  });

  test("saving the form preserves API-set explicit boolean preferences", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    const headers = {
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: APP_ORIGIN,
    };

    // Seed explicit default-side booleans the two-option UI never writes
    // itself but the API accepts: seconds shown (true), tz label hidden
    // (false). These are distinct from NULL ("never touched").
    await page.request.patch("/api/accounts/me/preferences", {
      data: { timeFormatSeconds: true, timeFormatTzLabel: false },
      headers,
    });

    // Open the form and save without touching the seconds / tz-label
    // controls. An untouched control must re-emit the loaded value
    // verbatim — not collapse the explicit boolean back to NULL.
    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: "Time format" }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Preferences saved")).toBeVisible({
      timeout: 5_000,
    });

    const res = await page.request.get("/api/accounts/me/preferences");
    const body = await res.json();
    expect(body.data.timeFormatSeconds).toBe(true);
    expect(body.data.timeFormatTzLabel).toBe(false);
  });
});

// ── Live timestamp update on save (#766) ───────────────────────────

test.describe("Time format — live update on save", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetAccountPreferences(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await revokeAllSessions(workerUsername);
    await resetAccountPreferences(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteWebAuthnCredentials(workerUsername);
    await resetAccountPreferences(workerUsername);
  });

  test("saving a time-format change updates live timestamps without reload", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Sign in BEFORE seeding the passkey: an enrolled passkey turns
    // sign-in into a WebAuthn MFA challenge the helper cannot complete.
    await signInAndWait(page, workerUsername, workerPassword);

    // Seed a passkey so the WebAuthn card renders a live <Timestamp> on
    // the same page as the preferences form, then load the profile.
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Live Timestamp Passkey",
    });
    await page.goto("/profile");

    await expect(page.getByText("Live Timestamp Passkey")).toBeVisible({
      timeout: 5_000,
    });

    // The created-at <Timestamp> resolves post-mount; capture its value.
    const stamp = page.locator("time").first();
    await expect(stamp).not.toHaveText("", { timeout: 5_000 });
    const before = (await stamp.textContent())?.trim();
    expect(before).toBeTruthy();

    // Hide seconds — a format change that always alters the general
    // timestamp output — then save.
    await page.locator("#tf-seconds").click();
    await page.getByRole("option", { name: "Hide" }).click();
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Preferences saved")).toBeVisible({
      timeout: 5_000,
    });

    // The provider re-fetch (not router.refresh alone) updates the live
    // timestamp in place — no page reload performed.
    await expect(stamp).not.toHaveText(before ?? "", { timeout: 5_000 });
  });
});
