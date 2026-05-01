import { closePools } from "./helpers/setup-db";
import { shutdownMockServers } from "./mock-server-state";

export default async function globalTeardown(): Promise<void> {
  await shutdownMockServers();
  await closePools();
}
