import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  authGet,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  deleteTestAccount,
  resetAccountDefaults,
} from "../helpers/setup-db";

const MONITOR_USERNAME = "integ-rbac-monitor";
const MONITOR_PASSWORD = "Monitor1234!";

describe("RBAC permission enforcement", () => {
  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await createTestAccount(
      MONITOR_USERNAME,
      MONITOR_PASSWORD,
      "Security Monitor",
    );
  });

  afterAll(async () => {
    await deleteTestAccount(MONITOR_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  it("admin can access audit-logs API", async () => {
    const session = await signIn(ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await authGet(session, "/api/audit-logs");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("total");
  });

  it("non-admin user gets 403 on audit-logs API", async () => {
    const session = await signIn(MONITOR_USERNAME, MONITOR_PASSWORD);

    const response = await authGet(session, "/api/audit-logs");

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });
});
