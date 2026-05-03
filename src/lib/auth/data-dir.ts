import "server-only";

import path from "node:path";

/**
 * Return the resolved data directory path.
 * Defaults to `./data` relative to the project root.
 *
 * The `process.cwd()` fallback is marked opaque to Next.js' File
 * Tracer so build-time tracing does not assume the whole project
 * root is the data directory and pull every operator file
 * (markdowns, configs, decisions/, e2e/, on-disk key material, …)
 * into `.next/standalone/`. See issue #407 for the trace details.
 */
export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data");
}
