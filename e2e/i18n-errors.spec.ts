import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInKo,
} from "./helpers/auth";
import {
  createFakeSessions,
  resetAccountDefaults,
  setAccountStatus,
  setMaxSessions,
} from "./helpers/setup-db";

const alert = (page: import("@playwright/test").Page) =>
  page.locator("p[role='alert']");

test.describe("Korean error messages", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
  });

  test.afterEach(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("/ko wrong credentials shows Korean error", async ({ page }) => {
    await signInKo(page, ADMIN_USERNAME, "WrongPassword!");

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "잘못된 계정 ID 또는 비밀번호입니다",
    );
  });

  test("/ko locked account shows Korean error", async ({ page }) => {
    await setAccountStatus(ADMIN_USERNAME, "locked", null);

    await signInKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "계정이 잠겨 있습니다. 나중에 다시 시도해 주세요.",
    );
  });

  test("/ko inactive account shows Korean error", async ({ page }) => {
    await setAccountStatus(ADMIN_USERNAME, "disabled");

    await signInKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("계정이 활성 상태가 아닙니다");
  });

  test("/ko max sessions shows Korean error", async ({ page }) => {
    await resetAccountDefaults(ADMIN_USERNAME);
    await setMaxSessions(ADMIN_USERNAME, 1);
    await createFakeSessions(ADMIN_USERNAME, 1);

    await signInKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("최대 활성 세션 수에 도달했습니다");
  });
});
