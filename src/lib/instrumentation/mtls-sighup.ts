import "server-only";

const KEY = Symbol.for("aice.mtls.sighup");

interface Slot {
  installed?: boolean;
  installing?: Promise<void>;
}

type Marked = typeof globalThis & { [KEY]?: Slot };

/**
 * Install a SIGHUP handler that calls `mtls.reload()` so a rotated
 * certificate on disk takes effect on the next outbound GraphQL request
 * without restarting the process.
 *
 * Idempotent across:
 *  - dev-mode HMR re-invocation of `instrumentation.register()`,
 *  - two concurrent calls (parallel module evaluation), via a shared
 *    `installing` promise that later callers join,
 *  - a transient `import("@/lib/mtls")` failure: `installing` is cleared
 *    so a subsequent call can retry, while `installed` remains unset.
 *
 * Uses a `globalThis[Symbol.for(...)]` slot rather than
 * `process.listenerCount("SIGHUP")` because another module may legitimately
 * add its own SIGHUP listener (e.g. a future graceful-shutdown hook); the
 * count check would incorrectly skip our registration in that case.
 */
export async function installMtlsSighupHandler(): Promise<void> {
  const g = globalThis as Marked;
  // Atomically reserve the slot for the first caller. Concurrent callers
  // observe the same Slot object and join `installing` instead of racing
  // to attach a second listener.
  if (!g[KEY]) g[KEY] = {};
  const slot: Slot = g[KEY];
  if (slot.installed) return;
  if (slot.installing) return slot.installing;

  slot.installing = (async () => {
    let succeeded = false;
    try {
      const mtls = await import("@/lib/mtls");
      const { reload } = mtls;
      // Defensive: in some test/mock setups the namespace can land with
      // `reload` missing or stubbed-to-undefined. Without this guard the
      // listener would attach with an undefined `reload` and the install
      // would silently "succeed", masking the failure from the caller.
      if (typeof reload !== "function") {
        throw new TypeError(
          `[mtls-sighup] @/lib/mtls.reload is ${typeof reload}, expected function`,
        );
      }
      process.on("SIGHUP", () => {
        reload()
          .then(() => {
            // eslint-disable-next-line no-console -- operator-visible signal
            console.info("[mtls] SIGHUP: reloaded mTLS materials");
          })
          .catch((err) => {
            // eslint-disable-next-line no-console -- operator-visible signal
            console.error("[mtls] SIGHUP: reload failed", err);
          });
      });
      succeeded = true;
    } finally {
      // On success, lock `installed=true` permanently. On failure, leave
      // `installed` unset and clear `installing` so a later retry can
      // complete; the caller still observes the rejection on this promise.
      if (succeeded) slot.installed = true;
      slot.installing = undefined;
    }
  })();
  return slot.installing;
}
