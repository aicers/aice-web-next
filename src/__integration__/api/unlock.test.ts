import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  deleteTestAccount,
  getAccountId,
  resetAccountDefaults,
  setAccountStatus,
  setLockoutCount,
} from "../helpers/setup-db";

const MONITOR_USERNAME = "integ-unlock-monitor";
const MONITOR_PASSWORD = "Monitor1234!";
const TARGET_USERNAME = "integ-unlock-target";
const TARGET_PASSWORD = "Target1234!";

describe("Account unlock/restore API", () => {
  let targetAccountId: string;

  beforeAll(async () => {
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

  afterAll(async () => {
    await deleteTestAccount(MONITOR_USERNAME);
    await deleteTestAccount(TARGET_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  it("admin can unlock a locked account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    await setAccountStatus(
      TARGET_USERNAME,
      "locked",
      new Date(Date.now() + 30 * 60_000),
    );
    await setLockoutCount(TARGET_USERNAME, 1);

    const response = await authPost(
      session,
      `/api/accounts/${targetAccountId}/unlock`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, action: "unlocked" });
  });

  it("admin can restore a suspended account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    await setAccountStatus(TARGET_USERNAME, "suspended", null);
    await setLockoutCount(TARGET_USERNAME, 2);

    const response = await authPost(
      session,
      `/api/accounts/${targetAccountId}/unlock`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, action: "restored" });
  });

  it("non-admin cannot unlock accounts (403)", async () => {
    const session = await signIn(MONITOR_USERNAME);

    await setAccountStatus(
      TARGET_USERNAME,
      "locked",
      new Date(Date.now() + 30 * 60_000),
    );

    const response = await authPost(
      session,
      `/api/accounts/${targetAccountId}/unlock`,
    );

    expect(response.status).toBe(403);
    await resetAccountDefaults(TARGET_USERNAME);
  });

  it("unlock returns 400 for active account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    await resetAccountDefaults(TARGET_USERNAME);

    const response = await authPost(
      session,
      `/api/accounts/${targetAccountId}/unlock`,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Account is not locked or suspended");
  });

  it("unlock returns 404 for non-existent account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(
      session,
      "/api/accounts/00000000-0000-0000-0000-000000000000/unlock",
    );

    expect(response.status).toBe(404);
  });
});
