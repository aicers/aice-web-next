import type { RunningMockServer } from "../src/test-harness/mock-server";

/**
 * Module-scoped handle so `global-teardown.ts` can stop the mock GraphQL
 * server that `global-setup.ts` started. Playwright runs both files in the
 * same Node process.
 */
const state: { server: RunningMockServer | null } = { server: null };

export function setMockServer(server: RunningMockServer): void {
  state.server = server;
}

export async function shutdownMockServer(): Promise<void> {
  if (!state.server) return;
  await state.server.close();
  state.server = null;
}

export function mockServerPort(): number {
  return Number(process.env.MOCK_REVIEW_GRAPHQL_PORT ?? "4012");
}

export function mockServerUrl(): string {
  // The harness serves the mock over HTTPS + mTLS so the dev server can
  // reach it via the production mTLS code path in `src/lib/mtls.ts`. See
  // `global-setup.ts` for how the test CA + client/server certs are
  // generated.
  return `https://127.0.0.1:${mockServerPort()}/graphql`;
}
