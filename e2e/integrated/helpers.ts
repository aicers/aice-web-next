import { existsSync, readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { SIGNING_KEY_PATH } from "./global-setup";
import type { Es256JwkPrivate } from "./lib/jws";

export const ADMIN_USERNAME = process.env.INIT_ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD = process.env.INIT_ADMIN_PASSWORD ?? "Admin1234!";

/**
 * Keycloak test user for the OIDC interactive sign-in scenarios. Defaults
 * match the seeded realm-export.json on the reference multi-host stack;
 * override via env when the operator's compose seeds a different account.
 */
export const KEYCLOAK_USERNAME = process.env.KEYCLOAK_TEST_USERNAME ?? "tester";
export const KEYCLOAK_PASSWORD =
  process.env.KEYCLOAK_TEST_PASSWORD ?? "Tester1234!";

/**
 * Drives the Keycloak interactive sign-in form when the analyze-bridge
 * cold path lands the new tab there. On the reference multi-host stack
 * Keycloak is reverse-proxied at `${AIMER_WEB_URL}/auth/...`, so the
 * browser never crosses to a separate origin — the URL pattern check
 * is therefore loose (`/auth/realms/<realm>`) rather than hostname-
 * based. The realm name defaults to `aimer` per the reference seed.
 */
export async function completeKeycloakSignIn(page: Page): Promise<void> {
  await page.waitForURL(/\/auth\/realms\/[^/]+\/protocol\/openid-connect/, {
    timeout: 30_000,
  });
  await page.locator("input[name='username']").fill(KEYCLOAK_USERNAME);
  await page.locator("input[name='password']").fill(KEYCLOAK_PASSWORD);
  await page.locator("input[name='login'], button[name='login']").click();
}

/**
 * Sign in to aice-web-next via the production sign-in surface (no
 * dev-only `/api/e2e/*` endpoints — this harness targets the prod build
 * running behind nginx). Mirrors `e2e/helpers/auth.ts` but skips the
 * rate-limit reset (no test endpoints available in prod).
 */
export async function signInAdmin(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
  await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
    timeout: 30_000,
  });
}

export const AICE_WEB_NEXT_URL =
  process.env.AICE_WEB_NEXT_URL ??
  "https://001.aice-web-next.aiceweb-host.test.local:9443";

export const AIMER_WEB_URL =
  process.env.AIMER_WEB_URL ??
  "https://001.aimer-web.aimer-web-host.test.local:19443";

/**
 * Loads the aice-web-next aimer-context signing key (JWK) from the
 * globalSetup-cached file. Returns `null` when the file is missing —
 * tamper specs should skip with a clear message instead of failing
 * the harness when the BFF container is not reachable.
 */
export function loadSigningKey(): Es256JwkPrivate | null {
  if (!existsSync(SIGNING_KEY_PATH)) return null;
  // The on-disk shape is `{ active: { privateKey, publicKey, ... }, previous?: ... }`
  // — see src/lib/aimer/signing-key.ts. We want the currently-active
  // private key (the one the BFF used to mint the JWS we're tampering).
  const raw = JSON.parse(readFileSync(SIGNING_KEY_PATH, "utf8")) as {
    active?: { privateKey?: Es256JwkPrivate };
  };
  return raw.active?.privateKey ?? null;
}

/**
 * Navigates from `/detection` through the "3 years" preset to the
 * first Blocklist Connection event detail page. Picked because
 * `BlocklistConn`'s detection-list GraphQL fragment includes
 * `origCustomer { id name }` (DGA/NonBrowser fragments omit it) so
 * the AimerBanner candidates list is populated, and the dump's
 * Customer A (id=1) — registered in REview with networks covering
 * 192.168.0.0/16 — surfaces on these events at GraphQL resolve time.
 *
 * Both seeding scripts under `seed/` MUST have been run on the stack
 * for the Send button to be enabled when this lands.
 */
export async function navigateToBlocklistConnEventDetail(
  page: Page,
): Promise<void> {
  await page.goto("/detection");
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /^Presets$/ }).click();
  await page.getByText("3 years", { exact: true }).click();
  await page.locator("text=Detected events").waitFor();
  // The chevron on the row is the only affordance that triggers
  // `handleRowInvestigate` → router.push("/events/<token>"); clicking
  // the event title only adds a kind filter to the current tab.
  await page
    .locator("li")
    .filter({ hasText: /Blocklist Connection/i })
    .first()
    .getByRole("button", { name: /investigation|investigate/i })
    .click();
  await page.waitForURL(/\/events\//, { timeout: 15_000 });
  // Banner renders client-side after the page lands; wait for the
  // Send button to attach.
  await page.getByTestId("aimer-send-button").waitFor({ timeout: 15_000 });
}
