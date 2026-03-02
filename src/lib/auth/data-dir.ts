import "server-only";

import path from "node:path";

/**
 * Return the resolved data directory path.
 * Defaults to `./data` relative to the project root.
 */
export function getDataDir(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  return path.resolve(dir);
}
