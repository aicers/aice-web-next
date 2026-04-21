import { closePools } from "./helpers/setup-db";
import { shutdownMockServer } from "./mock-server-state";

export default async function globalTeardown(): Promise<void> {
  await shutdownMockServer();
  await closePools();
}
