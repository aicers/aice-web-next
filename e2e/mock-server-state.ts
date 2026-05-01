import type { RunningMockServer } from "../src/test-harness/mock-server";

export type MockServerKind = "review" | "giganto" | "tivan";

const state: Record<MockServerKind, RunningMockServer | null> = {
  review: null,
  giganto: null,
  tivan: null,
};

export function setMockServer(
  kind: MockServerKind,
  server: RunningMockServer,
): void {
  state[kind] = server;
}

export async function shutdownMockServers(): Promise<void> {
  for (const kind of ["review", "giganto", "tivan"] as const) {
    const server = state[kind];
    if (!server) continue;
    await server.close();
    state[kind] = null;
  }
}

export function mockServerPort(kind: MockServerKind): number {
  switch (kind) {
    case "review":
      return Number(process.env.MOCK_REVIEW_GRAPHQL_PORT ?? "4012");
    case "giganto":
      return Number(process.env.MOCK_GIGANTO_GRAPHQL_PORT ?? "4013");
    case "tivan":
      return Number(process.env.MOCK_TIVAN_GRAPHQL_PORT ?? "4014");
  }
}

export function mockServerUrl(kind: MockServerKind): string {
  return `https://127.0.0.1:${mockServerPort(kind)}/graphql`;
}
