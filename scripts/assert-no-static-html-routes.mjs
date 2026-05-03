#!/usr/bin/env node
// Static-HTML-route guard (issue #418 §1, failure mode (e)).
//
// CSP nonce coverage (issue #418 §1) hinges on every HTML route
// being server-rendered per request — only a per-request render path
// can stamp the proxy-minted `'nonce-…'` value onto framework script
// tags. A statically prerendered HTML route is frozen at build time
// with no nonce attachable, so once CSP promotes from Report-Only
// to enforcing (issue #418 §2) the browser will refuse every script
// on that page.
//
// PR #413 closed this gap manually for `_not-found` by making the
// boundary opt out of static rendering via `await connection()`,
// and the manual gate at the end of that PR's review was "run
// `pnpm build` and confirm every HTML route is `ƒ` (dynamic) in
// the route map, not `○` (static)." This script is the automated
// version of that gate, intended to run on every CI build.
//
// The Playwright nonce-coverage spec at `e2e/csp-nonce.spec.ts`
// boots `pnpm dev` and so cannot reliably distinguish a route that
// regressed to static rendering — `next dev` always renders
// dynamically. This guard runs against the prod build's emitted
// artifacts and is therefore the only place the static-vs-dynamic
// regression surfaces in CI. Treat it as a sibling check to the
// Playwright spec, not a replacement for it.
//
// Mechanism: after `next build` finishes, walk `.next/server/app/`.
// Next 16 writes a `<route>.html` file there for every page that
// was statically prerendered, and writes only `<route>.rsc` /
// `<route>.js` (no `.html`) for dynamic pages. The presence of any
// `.html` under that subtree is therefore the unambiguous "this
// HTML route is static" signal — no need to parse the human-facing
// route table from stdout, which is brittle to format changes.
//
// Allowlist: `_global-error.html` is excluded. It is a Next-synthetic
// fallback (the framework's built-in 500 page that catches a thrown
// error from the root layout) and does NOT appear in the route table
// the issue references. It must be a Client Component per Next's
// contract, so it cannot opt out of static rendering via
// `await connection()` the way a Server Component page can. Its
// scripts would be refused by enforcing CSP, but the page is intended
// as a JS-less fallback for catastrophic render failures — the static
// error copy renders fine without any of those scripts. Treat it as
// out of scope for this guard; if future Next versions expose a way
// to make this synthetic dynamic, drop the allowlist and require it.
//
// Run via `pnpm build` (which chains `next build && node
// scripts/assert-no-static-html-routes.mjs`).

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

const APP_DIR = path.join(ROOT, ".next", "server", "app");

// Synthetic Next-internal HTML files that are intentionally static and
// outside the scope of this guard — see header comment for rationale.
// Paths are relative to `.next/server/app/` and use forward slashes.
const ALLOWED_STATIC_HTML = new Set(["_global-error.html"]);

function listStaticHtmlRoutes(dir) {
  const out = [];
  walk(dir, dir, out);
  return out.filter((rel) => !ALLOWED_STATIC_HTML.has(rel));
}

function walk(rootDir, currentDir, out) {
  let entries;
  try {
    entries = readdirSync(currentDir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(currentDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(rootDir, abs, out);
    } else if (entry.endsWith(".html")) {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      out.push(rel);
    }
  }
}

function main() {
  let appDirExists = true;
  try {
    statSync(APP_DIR);
  } catch (err) {
    if (err.code === "ENOENT") appDirExists = false;
    else throw err;
  }

  if (!appDirExists) {
    console.error(
      `[assert-no-static-html-routes] FAIL — ${path.relative(ROOT, APP_DIR)} ` +
        "does not exist. Did `next build` run before this script? The guard " +
        "is intended to run as the second half of `pnpm build`.",
    );
    return 1;
  }

  const htmlFiles = listStaticHtmlRoutes(APP_DIR);

  if (htmlFiles.length === 0) {
    console.log(
      "[assert-no-static-html-routes] OK — no statically prerendered HTML " +
        "routes detected under .next/server/app. CSP nonce coverage is safe " +
        "across the build.",
    );
    return 0;
  }

  console.error(
    `[assert-no-static-html-routes] FAIL — ${htmlFiles.length} statically ` +
      "prerendered HTML route(s) detected. CSP cannot stamp a per-request " +
      "nonce onto a build-time-frozen page, so once CSP promotes to " +
      "enforcing (#418 §2) the browser will refuse every script on these " +
      "pages. Make each affected page dynamic via `await connection()` (see " +
      "src/app/not-found.tsx for the pattern):\n",
  );
  for (const file of htmlFiles.sort()) {
    console.error(`  • .next/server/app/${file}`);
  }
  return 1;
}

process.exit(main());
