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
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
