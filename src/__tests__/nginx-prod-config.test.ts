import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression coverage for the nginx-side half of the `9443:443` host
// mapping change. The proxy.test.ts suite drives `NextRequest` directly
// with an authority that already carries `:9443`, which exercises the
// app's behavior but cannot fail when the prod nginx config is reverted
// to `proxy_set_header Host $host` — the bug surfaces only because
// `$host` strips the port nginx received from the browser. These tests
// pin the directive at the config layer so that a future edit to
// `infra/nginx/nginx.prod.conf` cannot silently re-introduce the
// regression.
const PROD_CONF_PATH = path.resolve(
  __dirname,
  "../../infra/nginx/nginx.prod.conf",
);

const prodConf = readFileSync(PROD_CONF_PATH, "utf8");

describe("infra/nginx/nginx.prod.conf", () => {
  it("forwards the original Host header verbatim with $http_host", () => {
    // `$http_host` echoes whatever authority the browser sent (including
    // the non-standard `:9443` port); `$host` would normalize it and
    // strip the port, breaking absolute redirects derived from
    // `request.url` (e.g. `redirectToSignIn` in src/proxy.ts).
    expect(prodConf).toMatch(/proxy_set_header\s+Host\s+\$http_host\s*;/);
  });

  it("does not forward Host as $host (port-stripping variant)", () => {
    expect(prodConf).not.toMatch(/proxy_set_header\s+Host\s+\$host\s*;/);
  });
});
