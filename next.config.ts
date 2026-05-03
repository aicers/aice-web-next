import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  // The Node management dispatch layer reads its GraphQL operations
  // from `src/lib/node/queries/**/*.graphql` at module init via
  // `process.cwd()`. The trace-include keeps those files in the
  // standalone output so the runtime path resolves correctly.
  outputFileTracingIncludes: {
    "/api/nodes/**/*": ["./src/lib/node/queries/**/*"],
    "/[locale]/(dashboard)/nodes/**/*": ["./src/lib/node/queries/**/*"],
  },
  // Backstop against future NFT regressions broadening route
  // traces to the project root. Only excludes operator-side files
  // that are never read at runtime — note that excludes do not
  // apply to `instrumentation.js.nft.json`, so the structural fix
  // in `data-dir.ts` / `jwt-keys.ts` is what actually keeps the
  // standalone bundle clean. See #407.
  outputFileTracingExcludes: {
    "/*": [
      "**/*.md",
      "**/Dockerfile",
      "**/docker-compose*.yml",
      "**/biome.json",
      "**/components.json",
      "LICENSE",
      "pnpm-lock.yaml",
      "decisions/**",
      "data/**",
      "data-e2e/**",
      "e2e/**",
      "docs/**",
      "site/**",
      "playwright-report/**",
    ],
  },
  experimental: {
    // Enables the navigation `forbidden()` helper used by the Node
    // Status / Settings tabs to surface a real HTTP 403 (with the
    // sibling `forbidden.tsx` UI) when the caller is missing the
    // `nodes:read + services:read` combined gate, instead of silently
    // bouncing them off the route.
    authInterrupts: true,
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
