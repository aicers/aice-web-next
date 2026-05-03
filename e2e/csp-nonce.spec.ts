import type { Page, Response } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";

/**
 * Automated nonce-coverage check (issue #418 §1).
 *
 * Today the proxy emits `Content-Security-Policy-Report-Only` with a
 * per-request `'nonce-…'` value, and the renderer is responsible for
 * stamping that nonce onto every `<script>` it emits. PR #413 closed
 * the static-boundary gap manually, but only eyeballing
 * "view-source → does every script have the right nonce?" verified it.
 * Promoting CSP from Report-Only to enforcing (#418 §2) without an
 * automated check creates a window where a regression breaks every
 * page in production and only surfaces in user reports — this spec
 * is the regression net.
 *
 * Coverage matches the floor stated in #418 §1:
 *   • a public route (`/sign-in`)
 *   • a `[locale]` dashboard page (default + non-default locale)
 *   • the root `/missing` not-found backstop (PR #413's `app/not-found.tsx`)
 *   • the `[locale]` not-found locale boundary
 *     (`/ko/missing`, `/en/missing`, `/xx/missing`)
 *
 * Notes on what this spec can and cannot validate, per #418 §1:
 *   • The Playwright harness boots `pnpm dev` (see
 *     `e2e/playwright.config.ts` `webServer.command`), so this run does
 *     **not** validate the nginx hop or prod build's static-vs-dynamic
 *     decisions. The `static-vs-dynamic` failure mode (#418 §1 (e)) is
 *     enforced separately by `scripts/assert-no-static-html-routes.mjs`
 *     against the prod build output.
 *   • Assertions read `HTMLScriptElement.nonce` (the IDL attribute),
 *     not `getAttribute("nonce")`. Modern browsers clear the content
 *     attribute after parsing for CSP defense-in-depth (nonce
 *     hiding), so the IDL value is the only reliable observation
 *     point. Same reasoning will extend to `HTMLStyleElement.nonce`
 *     when #418 §3 lands.
 *
 * Auth precondition: the proxy is fail-closed (only `/` and
 * `/sign-in` are public per `src/lib/auth/proxy-auth.ts`), so any
 * unauthenticated hit to `/missing*` would redirect to sign-in and
 * the test would assert against the sign-in page instead of the
 * not-found HTML. Every not-found / dashboard test seeds a worker
 * session before navigating.
 */

const CSP_HEADER = "content-security-policy-report-only";

function extractNonceFromHeader(headerValue: string | undefined): string {
  if (!headerValue) {
    throw new Error(
      `expected ${CSP_HEADER} response header but it was missing`,
    );
  }
  const match = headerValue.match(/'nonce-([A-Za-z0-9+/=_-]+)'/);
  if (!match) {
    throw new Error(
      `${CSP_HEADER} header has no 'nonce-…' source: ${headerValue}`,
    );
  }
  return match[1];
}

type ScriptObservation = {
  /**
   * `HTMLScriptElement.nonce` (IDL attribute, not getAttribute). Typed
   * as `string | undefined` because the lib.dom typing is optional —
   * an absent nonce is itself a failure mode the assertion must
   * surface, so we propagate the optionality rather than narrowing it
   * away inside the page-context evaluate.
   */
  nonce: string | undefined;
  /** Resolved `src`, empty for inline scripts. */
  src: string;
  /** Short identifier for failure diagnostics. */
  snippet: string;
};

async function readScriptNonces(page: Page): Promise<ScriptObservation[]> {
  return page.$$eval("script", (scripts) =>
    scripts.map((s) => ({
      // IDL attribute — survives nonce hiding (the content attribute
      // is cleared post-parse). `getAttribute("nonce")` would return
      // an empty string here even when the policy is correctly
      // applied, so it must NOT be used as the assertion source.
      nonce: s.nonce,
      src: s.src,
      snippet: s.outerHTML.slice(0, 120),
    })),
  );
}

function assertEveryScriptCarriesNonce(
  scripts: ScriptObservation[],
  expectedNonce: string,
  context: string,
): void {
  expect(
    scripts.length,
    `[${context}] no <script> tags in rendered DOM — the route may have ` +
      "regressed to static rendering and shipped without any nonce-bearing " +
      "script. Verify the corresponding page opts out of static rendering " +
      "via `await connection()` (see app/not-found.tsx for the pattern).",
  ).toBeGreaterThan(0);

  for (const s of scripts) {
    expect(
      s.nonce,
      `[${context}] <script> missing or wrong nonce: ${s.snippet}`,
    ).toBe(expectedNonce);
  }
}

async function assertNonceCoverage(
  page: Page,
  response: Response | null,
  context: string,
): Promise<void> {
  if (response === null) {
    throw new Error(`[${context}] page.goto returned no response`);
  }
  const nonce = extractNonceFromHeader(response.headers()[CSP_HEADER]);
  const scripts = await readScriptNonces(page);
  assertEveryScriptCarriesNonce(scripts, nonce, context);
}

test.describe("CSP nonce coverage", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
  });

  test("public /sign-in: every <script> carries the response nonce", async ({
    page,
  }) => {
    const response = await page.goto("/sign-in");
    await assertNonceCoverage(page, response, "/sign-in");
  });

  test("[locale] /dashboard (default locale) is fully nonced", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const response = await page.goto("/dashboard");
    await assertNonceCoverage(page, response, "/dashboard");
  });

  test("[locale] /ko/dashboard (non-default locale) is fully nonced", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const response = await page.goto("/ko/dashboard");
    await assertNonceCoverage(page, response, "/ko/dashboard");
  });

  // PR #413's "all four URL shapes" — the floor for not-found
  // coverage. `/missing` exercises the root `app/not-found.tsx`
  // backstop, the locale-prefixed variants exercise
  // `app/[locale]/not-found.tsx`, and `/xx/missing` exercises the
  // invalid-locale shape that escapes the `[locale]` segment back
  // to the root boundary.
  for (const path of [
    "/missing",
    "/en/missing",
    "/ko/missing",
    "/xx/missing",
  ]) {
    test(`not-found ${path} is fully nonced`, async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      const response = await page.goto(path);
      await assertNonceCoverage(page, response, path);
    });
  }
});
