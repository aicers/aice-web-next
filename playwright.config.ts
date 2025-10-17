import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      MOCK_REVIEW_SIGN_IN: "true",
      NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT:
        process.env.NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT ??
        "http://127.0.0.1:4000/graphql",
      NEXT_PUBLIC_REVIEW_STREAM_ENDPOINT:
        process.env.NEXT_PUBLIC_REVIEW_STREAM_ENDPOINT ??
        "http://127.0.0.1:4000/stream",
    },
  },
});
