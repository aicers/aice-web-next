import { test as base } from "@playwright/test";

import {
  createTestAccount,
  resetAccountDefaults,
  setPassword,
} from "./helpers/setup-db";

const WORKER_PASSWORD = "WorkerPass1234!";

type WorkerFixtures = {
  /** Username unique to this Playwright worker, e.g. `e2e-worker-0`. */
  workerUsername: string;
  /** Password for the worker account. */
  workerPassword: string;
  /** Returns a worker-scoped prefix: `${base}w${workerIndex}-`. */
  workerPrefix: (base: string) => string;
};

export const test = base.extend<object, WorkerFixtures>({
  workerUsername: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
    async ({}, use, workerInfo) => {
      const username = `e2e-worker-${workerInfo.workerIndex}`;
      await createTestAccount(username, WORKER_PASSWORD, "E2E Test Admin");
      await resetAccountDefaults(username);
      await setPassword(username, WORKER_PASSWORD);
      await use(username);
      await resetAccountDefaults(username);
    },
    { scope: "worker" },
  ],

  workerPassword: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
    async ({}, use) => {
      await use(WORKER_PASSWORD);
    },
    { scope: "worker" },
  ],

  workerPrefix: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
    async ({}, use, workerInfo) => {
      await use((base: string) => `${base}w${workerInfo.workerIndex}-`);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
