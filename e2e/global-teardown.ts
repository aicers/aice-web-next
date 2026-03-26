import { closePools } from "./helpers/setup-db";

export default async function globalTeardown(): Promise<void> {
  await closePools();
}
