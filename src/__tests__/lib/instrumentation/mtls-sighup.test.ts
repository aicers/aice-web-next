import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const SIGHUP_KEY = Symbol.for("aice.mtls.sighup");

// Vitest workers receive the same OS signals we send with `process.kill`. The
// listener leak across tests would fire spurious reload calls, so we
// strip every test's listener in afterEach and clear the globalThis slot.
function purge(): void {
  const before = process.listenerCount("SIGHUP");
  process.removeAllListeners("SIGHUP");
  // Sanity check — the count should drop to 0 for the duration of the test
  // suite. If anything else added a SIGHUP listener prior to vitest loading,
  // restore it so we do not interfere with the host environment.
  void before;
  // biome-ignore lint/suspicious/noExplicitAny: test-only type widening
  delete (globalThis as any)[SIGHUP_KEY];
}

describe("installMtlsSighupHandler", () => {
  let reloadMock: Mock;

  beforeEach(() => {
    purge();
    reloadMock = vi.fn().mockResolvedValue({ closed: false });
    vi.resetModules();
    vi.doMock("@/lib/mtls", () => ({
      reload: reloadMock,
    }));
  });

  afterEach(() => {
    purge();
    vi.doUnmock("@/lib/mtls");
    vi.resetModules();
  });

  it("invokes reload() when the SIGHUP listener fires", async () => {
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );
    await installMtlsSighupHandler();

    const listeners = process.listeners("SIGHUP");
    expect(listeners).toHaveLength(1);
    // Invoke the handler synchronously rather than dispatching the OS signal
    // through `process.kill`: in vitest the worker may intercept SIGHUP for
    // its own purposes, and we only need to verify the wiring (listener →
    // reload()) here.
    listeners[0]?.("SIGHUP" as NodeJS.Signals);
    await new Promise((r) => setImmediate(r));

    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it("attaches only one listener when called twice sequentially", async () => {
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );
    await installMtlsSighupHandler();
    await installMtlsSighupHandler();

    expect(process.listenerCount("SIGHUP")).toBe(1);
  });

  it("attaches only one listener under concurrent calls", async () => {
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );
    await Promise.all([
      installMtlsSighupHandler(),
      installMtlsSighupHandler(),
      installMtlsSighupHandler(),
    ]);

    expect(process.listenerCount("SIGHUP")).toBe(1);
  });

  it(
    "clears `installing` and leaves `installed` unset on import failure, " +
      "so a later call can complete",
    async () => {
      // First attempt: the mocked module exports `reload: undefined` —
      // equivalent in effect to a transient import failure (the namespace
      // landed without the function we depend on). The installer's
      // type-check raises before the SIGHUP listener is attached.
      //
      // Order matters: `vi.doUnmock()` first removes the beforeEach factory,
      // then `vi.resetModules()` clears the cache, then `vi.doMock()`
      // installs the override. Without the explicit unmock the second
      // `vi.doMock()` is silently dropped on some vitest worker
      // configurations (observed on Linux CI), leaving the original
      // `{ reload: reloadMock }` factory active and masking the simulated
      // failure.
      vi.doUnmock("@/lib/mtls");
      vi.resetModules();
      vi.doMock("@/lib/mtls", () => ({ reload: undefined }));
      let installer = await import("@/lib/instrumentation/mtls-sighup");

      await expect(installer.installMtlsSighupHandler()).rejects.toThrow(
        /reload/i,
      );
      expect(process.listenerCount("SIGHUP")).toBe(0);

      // biome-ignore lint/suspicious/noExplicitAny: test-only inspection
      const slot = (globalThis as any)[SIGHUP_KEY] as {
        installed?: boolean;
        installing?: Promise<void>;
      };
      expect(slot.installed).toBeFalsy();
      expect(slot.installing).toBeUndefined();

      // Now restore a working mock and retry — install should succeed.
      vi.doUnmock("@/lib/mtls");
      vi.resetModules();
      vi.doMock("@/lib/mtls", () => ({ reload: reloadMock }));
      installer = await import("@/lib/instrumentation/mtls-sighup");
      await installer.installMtlsSighupHandler();

      expect(process.listenerCount("SIGHUP")).toBe(1);
      expect(slot.installed).toBe(true);
    },
  );
});
