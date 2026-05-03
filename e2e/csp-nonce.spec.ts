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
  /** Whether the element carries `data-nextjs-dev-overlay` — the dev
   * error-overlay portal Next injects in dev mode only. */
  isDevOverlay: boolean;
  /** Short identifier for failure diagnostics. */
  snippet: string;
};

/**
 * The Playwright harness boots `pnpm dev --turbopack`, which injects
 * several dev-runtime artifacts into every HTML response that never
 * ship to production:
 *
 *   • Turbopack HMR client chunk
 *     (`/_next/static/chunks/[turbopack]_browser_dev_hmr-client_*.js`)
 *   • Turbopack dev module chunks named after the source path with a
 *     `_._.js` suffix (e.g.
 *     `/_next/static/chunks/src_app_%5Blocale%5D_not-found_tsx_0.-.k9_._.js`).
 *     Production Turbopack output uses content-hashed names without
 *     that suffix.
 *
 * `pnpm build` emits none of these, so excluding them from the dev-mode
 * assertion does not lose prod coverage. The static-vs-dynamic guard
 * (`scripts/assert-no-static-html-routes.mjs`) is what protects prod
 * nonce coverage; this dev exclusion keeps the smoke test honest.
 */
const DEV_ONLY_SCRIPT_SRC =
  /\/_next\/static\/chunks\/(?:(?:%5B|\[)turbopack(?:%5D|\])_browser_dev_|.+_\._\.js$)/;

async function readScriptNonces(page: Page): Promise<ScriptObservation[]> {
  const all = await page.$$eval("script", (scripts) =>
    scripts.map((s) => ({
      // IDL attribute — survives nonce hiding (the content attribute
      // is cleared post-parse). `getAttribute("nonce")` would return
      // an empty string here even when the policy is correctly
      // applied, so it must NOT be used as the assertion source.
      nonce: s.nonce,
      src: s.src,
      // Next's dev error overlay portal — `<script data-nextjs-dev-overlay="true">`.
      // Dev-only, never emitted by `pnpm build`.
      isDevOverlay: s.dataset.nextjsDevOverlay === "true",
      snippet: s.outerHTML.slice(0, 120),
    })),
  );
  return all.filter((s) => !s.isDevOverlay && !DEV_ONLY_SCRIPT_SRC.test(s.src));
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
  // Reset before every test, not just beforeAll: this spec calls
  // `signInAndWait` in 6 of 7 tests (dashboard ×2 + missing ×4) and
  // a single `pnpm e2e` worker reuses the same `e2e-worker-N`
  // username across them. Six sign-ins without resets trip the
  // proxy's per-account rate limiter, and the last not-found test
  // fails with "Too many attempts" on local single-worker runs
  // (CI's 4-worker fan-out hides this by spreading sign-ins across
  // accounts). Match the convention used by `e2e/dashboard.spec.ts`.
  test.beforeEach(async () => {
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
