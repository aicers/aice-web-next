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
  setAccountStatus,
} from "./helpers/setup-db";

// ── Constants ────────────────────────────────────────────────────

const NOPERM_USER = "e2e-dashboard-noperm";
const NOPERM_PASS = "Noperm1234!";
const NOPERM_ROLE = "E2E No Dashboard";

const READER_USER = "e2e-dashboard-reader";
const READER_PASS = "Reader1234!";
const READER_ROLE = "E2E Dashboard Reader";

const LOCKED_USER = "e2e-dashboard-locked";
const LOCKED_PASS = "Locked1234!";

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

// ── Setup / Teardown ─────────────────────────────────────────────

test.beforeAll(async () => {
  await resetRateLimits();

  // Role with no dashboard permissions
  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);

  // Role with dashboard:read only (no write)
  await createTestRole(READER_ROLE, ["dashboard:read"]);
  await createTestAccount(READER_USER, READER_PASS, READER_ROLE);

  // Account to lock for locked-accounts card test
  await createTestAccount(LOCKED_USER, LOCKED_PASS, "Tenant Administrator");
});

test.beforeEach(async () => {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
});

test.afterAll(async () => {
  try {
    await deleteTestAccount(NOPERM_USER);
    await deleteTestAccount(READER_USER);
    await deleteTestAccount(LOCKED_USER);
    await deleteTestRole(NOPERM_ROLE);
    await deleteTestRole(READER_ROLE);
  } catch {
    // best-effort cleanup
  }
});

// ── API tests ────────────────────────────────────────────────────

test("GET /api/dashboard/sessions returns active sessions", async ({
  page,
}) => {
  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  const response = await page.request.get("/api/dashboard/sessions");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.data.length).toBeGreaterThanOrEqual(1);

  // Admin's own session should be present
  const adminSession = body.data.find(
    (s: { username: string }) => s.username === ADMIN_USERNAME,
  );
  expect(adminSession).toBeDefined();
  expect(adminSession.ip_address).toBeTruthy();
});

test("GET /api/dashboard/locked-accounts returns locked accounts", async ({
  page,
}) => {
  // Lock the test account
  await setAccountStatus(LOCKED_USER, "locked", new Date(Date.now() + 3600000));

  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  const response = await page.request.get("/api/dashboard/locked-accounts");
  expect(response.status()).toBe(200);

  const body = await response.json();
  const locked = body.data.find(
    (a: { username: string }) => a.username === LOCKED_USER,
  );
  expect(locked).toBeDefined();
  expect(locked.status).toBe("locked");

  // Restore for subsequent tests
  await setAccountStatus(LOCKED_USER, "active");
});

test("GET /api/dashboard/alerts returns alerts array", async ({ page }) => {
  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  const response = await page.request.get("/api/dashboard/alerts");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test("POST /api/dashboard/sessions/[sid]/revoke revokes a session", async ({
  page,
}) => {
  // Create a session for the reader user by signing in
  await signInAndWait(page, READER_USER, READER_PASS);

  // Now sign in as admin
  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  const csrf = await getCsrf(page);

  // Find the reader's session
  const sessionsRes = await page.request.get("/api/dashboard/sessions");
  const sessions = await sessionsRes.json();
  const readerSession = sessions.data.find(
    (s: { username: string }) => s.username === READER_USER,
  );
  expect(readerSession).toBeDefined();

  // Revoke it
  const revokeRes = await page.request.post(
    `/api/dashboard/sessions/${readerSession.sid}/revoke`,
    { headers: csrfHeader(csrf) },
  );
  expect(revokeRes.status()).toBe(200);
  const revokeBody = await revokeRes.json();
  expect(revokeBody.ok).toBe(true);

  // Verify it's gone from the sessions list
  const verifyRes = await page.request.get("/api/dashboard/sessions");
  const verifyBody = await verifyRes.json();
  const found = verifyBody.data.find(
    (s: { sid: string }) => s.sid === readerSession.sid,
  );
  expect(found).toBeUndefined();
});

test("POST revoke returns 404 for non-existent session", async ({ page }) => {
  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  const csrf = await getCsrf(page);

  const response = await page.request.post(
    "/api/dashboard/sessions/00000000-0000-0000-0000-000000000000/revoke",
    { headers: csrfHeader(csrf) },
  );
  expect(response.status()).toBe(404);
});

// ── RBAC tests ───────────────────────────────────────────────────

test("user without dashboard:read gets 403 on sessions endpoint", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);

  const response = await page.request.get("/api/dashboard/sessions");
  expect(response.status()).toBe(403);
});

test("user without dashboard:read gets 403 on locked-accounts endpoint", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);

  const response = await page.request.get("/api/dashboard/locked-accounts");
  expect(response.status()).toBe(403);
});

test("user without dashboard:read gets 403 on alerts endpoint", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);

  const response = await page.request.get("/api/dashboard/alerts");
  expect(response.status()).toBe(403);
});

test("dashboard:read user cannot revoke sessions (needs dashboard:write)", async ({
  page,
}) => {
  await signInAndWait(page, READER_USER, READER_PASS);
  const csrf = await getCsrf(page);

  const response = await page.request.post(
    "/api/dashboard/sessions/00000000-0000-0000-0000-000000000000/revoke",
    { headers: csrfHeader(csrf) },
  );
  expect(response.status()).toBe(403);
});

// ── UI tests ─────────────────────────────────────────────────────

test("dashboard page renders three cards for admin", async ({ page }) => {
  await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto("/dashboard");

  // Wait for the dashboard title to appear
  await expect(page.getByRole("heading", { name: /Dashboard/i })).toBeVisible({
    timeout: 10000,
  });

  // All three card titles should be present
  await expect(page.getByText("Active Sessions").first()).toBeVisible();
  await expect(
    page.getByText("Locked & Suspended Accounts"),
  ).toBeVisible();
  await expect(page.getByText("Suspicious Activity").first()).toBeVisible();
});

test("dashboard page redirects for user without dashboard:read", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/dashboard");

  // Should redirect away from /dashboard (requirePermission redirects to /)
  await page.waitForURL((url) => !url.pathname.includes("/dashboard"), {
    timeout: 10000,
  });
});

test("dashboard:read user cannot see revoke buttons", async ({ page }) => {
  await signInAndWait(page, READER_USER, READER_PASS);
  await page.goto("/dashboard");

  // Wait for sessions card to load
  await expect(page.getByText("Active Sessions")).toBeVisible({
    timeout: 10000,
  });

  // Wait for data to load (either sessions show or "No active sessions")
  await expect(
    page.getByText("Active Sessions").locator("..").locator(".."),
  ).toBeVisible();

  // Revoke buttons should not be present for read-only user
  const revokeButtons = page.getByRole("button", { name: /Revoke/i });
  await expect(revokeButtons).toHaveCount(0);
});

test("locked account shows in dashboard card", async ({ page }) => {
  // Lock the test account
  await setAccountStatus(LOCKED_USER, "locked", new Date(Date.now() + 3600000));

  try {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/dashboard");

    // Wait for locked accounts card to render
    await expect(
      page.getByText("Locked & Suspended Accounts"),
    ).toBeVisible({ timeout: 10000 });

    // The locked user should appear
    await expect(page.getByText(LOCKED_USER)).toBeVisible({ timeout: 5000 });
  } finally {
    // Restore account status to avoid leaking state
    await setAccountStatus(LOCKED_USER, "active");
  }
});
