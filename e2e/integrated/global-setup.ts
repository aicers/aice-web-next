import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { request as createRequest } from "@playwright/test";

import { ADMIN_PASSWORD, ADMIN_USERNAME, AICE_WEB_NEXT_URL } from "./helpers";

/**
 * One-shot sign-in that persists the resulting cookies to `auth.json`
 * so all engine projects in the integrated config reuse the same
 * authenticated context. The prod build under test has no test-only
 * `/api/e2e/reset-rate-limits` endpoint, so repeating the password-flow
 * across 3 engines × N specs is not viable.
 */
export const STORAGE_STATE_PATH = resolve(
  __dirname,
  ".auth/admin-storage-state.json",
);

export default async function globalSetup(): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });

  const ctx = await createRequest.newContext({
    baseURL: AICE_WEB_NEXT_URL,
    ignoreHTTPSErrors: true,
  });

  // The sign-in route is the entry point and does not check CSRF (the
  // CSRF cookie is issued post-sign-in and required only by mutating
  // routes thereafter). POST directly with credentials.
  const signInResponse = await ctx.post("/api/auth/sign-in", {
    headers: {
      "Content-Type": "application/json",
      Origin: AICE_WEB_NEXT_URL,
    },
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (!signInResponse.ok()) {
    const body = await signInResponse.text();
    throw new Error(
      `global-setup: admin sign-in failed (${signInResponse.status()}): ${body}`,
    );
  }

  const state = await ctx.storageState();
  writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  await ctx.dispose();
}
