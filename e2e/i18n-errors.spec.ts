import { expect, test } from "./fixtures";
import { resetRateLimits, signInKo } from "./helpers/auth";
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

  test.afterEach(async ({ workerUsername }) => {
    await resetAccountDefaults(workerUsername);
  });

  test("/ko wrong credentials shows Korean error", async ({
    page,
    workerUsername,
  }) => {
    await signInKo(page, workerUsername, "WrongPassword!");

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "잘못된 계정 ID 또는 비밀번호입니다",
    );
  });

  test("/ko locked account shows Korean error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountStatus(workerUsername, "locked", null);

    await signInKo(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "계정이 잠겨 있습니다. 나중에 다시 시도해 주세요.",
    );
  });

  test("/ko inactive account shows Korean error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountStatus(workerUsername, "disabled");

    await signInKo(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("계정이 활성 상태가 아닙니다");
  });

  test("/ko max sessions shows Korean error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    await setMaxSessions(workerUsername, 1);
    await createFakeSessions(workerUsername, 1);

    await signInKo(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("최대 활성 세션 수에 도달했습니다");
  });
});
