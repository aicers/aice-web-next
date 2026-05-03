/**
 * Unit tests for the leased-state lifecycle in `src/lib/mtls.ts`:
 * refcount accounting, single-writer mutex, reload coalesce + dirty flag,
 * deferred close, release idempotency.
 *
 * Uses an fs mock so each "buildState" can read different cert/key bytes
 * without touching real files, and an undici Agent spy to observe close().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EC256_CERT, EC256_KEY, EC384_CERT, EC384_KEY } from "./fixtures";

const fileStore: Record<string, string> = {};

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((p: string) => {
    if (p in fileStore) return fileStore[p];
    throw new Error(`ENOENT: ${p}`);
  }),
}));

/**
 * Hoisted state used by the `jose` partial mock to inject a controllable
 * barrier into `importPKCS8`. Tests that need to park `buildState()`
 * mid-flight (e.g. the `reloadDirty` regression) install a barrier and
 * await the `entered` promise so they know the first read has already
 * captured the old disk content before they swap it.
 */
const importHook = vi.hoisted(() => ({
  barrier: null as Promise<void> | null,
  release: (() => {}) as () => void,
  entered: (() => {}) as () => void,
}));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    importPKCS8: vi.fn(async (key: string, alg: string) => {
      importHook.entered();
      if (importHook.barrier) await importHook.barrier;
      return actual.importPKCS8(key, alg);
    }),
  };
});

function setEnv(certPem: string, keyPem: string) {
  process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
  process.env.MTLS_KEY_PATH = "/tmp/key.pem";
  process.env.MTLS_CA_PATH = "/tmp/ca.pem";
  Object.assign(fileStore, {
    "/tmp/cert.pem": certPem,
    "/tmp/key.pem": keyPem,
    "/tmp/ca.pem": certPem,
  });
}

function clearEnv() {
  delete process.env.MTLS_CERT_PATH;
  delete process.env.MTLS_KEY_PATH;
  delete process.env.MTLS_CA_PATH;
  for (const k of Object.keys(fileStore)) delete fileStore[k];
}

describe("mtls lifecycle", () => {
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    vi.resetModules();
    setEnv(EC256_CERT, EC256_KEY);
    importHook.barrier = null;
    importHook.release = () => {};
    importHook.entered = () => {};
    mtls = await import("@/lib/mtls");
  });

  afterEach(() => {
    importHook.barrier = null;
    importHook.release = () => {};
    importHook.entered = () => {};
    clearEnv();
  });

  it("createMtlsRequestAuth returns a release that is idempotent", async () => {
    const lease = await mtls.createMtlsRequestAuth("admin");
    const closeSpy = vi
      .spyOn(lease.agent, "close")
      .mockResolvedValue(undefined);

    // Retire the active state so any release() decision turns observable
    // through the close-deferral path.
    await mtls.reload();
    expect(closeSpy).not.toHaveBeenCalled();

    lease.release();
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalledOnce();

    // Duplicate release is a no-op — must not push refCount negative
    // (which would corrupt the close-deferral timing for the next retire).
    lease.release();
    lease.release();
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("concurrent first-use init returns the same agent (single writer)", async () => {
    const [a, b, c] = await Promise.all([
      mtls.createMtlsRequestAuth("a"),
      mtls.createMtlsRequestAuth("b"),
      mtls.createMtlsRequestAuth("c"),
    ]);
    expect(b.agent).toBe(a.agent);
    expect(c.agent).toBe(a.agent);
    a.release();
    b.release();
    c.release();
  });

  it("reload swaps to new key material; subsequent JWT uses the new alg", async () => {
    const { decodeProtectedHeader } = await import("jose");

    const tok1 = await mtls.signContextJwt("admin");
    expect(decodeProtectedHeader(tok1).alg).toBe("ES256");

    setEnv(EC384_CERT, EC384_KEY);
    await mtls.reload();

    const tok2 = await mtls.signContextJwt("admin");
    expect(decodeProtectedHeader(tok2).alg).toBe("ES384");
  });

  it("concurrent reloads coalesce — both callers see the same agent", async () => {
    await mtls.getAgent();
    const [a1, a2] = await Promise.all([mtls.reload(), mtls.reload()]);
    expect(a1).toBe(a2);
  });

  it("reloadDirty causes a mid-reload SIGHUP to re-read disk once more", async () => {
    const { decodeProtectedHeader } = await import("jose");

    // Prime state with EC256.
    await mtls.getAgent();
    const tokInit = await mtls.signContextJwt("admin");
    expect(decodeProtectedHeader(tokInit).alg).toBe("ES256");

    // Park the *next* buildState() inside importPKCS8 so it captures the
    // current (EC256) disk content via readFileSync but does not finish
    // installing state yet. Without this barrier the body would run to
    // completion before our `setEnv(EC384_*)` below — so the first
    // iteration would already read EC384, and the test would pass even if
    // the do/while reloadDirty re-iteration logic were removed.
    const enteredP = new Promise<void>((r) => {
      importHook.entered = r;
    });
    importHook.barrier = new Promise<void>((r) => {
      importHook.release = r;
    });

    const first = mtls.reload();
    // Wait until the parked first build has actually called importPKCS8 —
    // i.e. readFileSync has already captured EC256 into local cert/key vars.
    await enteredP;

    // Disarm the barrier so the second iteration's importPKCS8 does NOT
    // block, then swap the disk to EC384 and fire a second reload. The
    // second call sees `reloadPending` set, flips `reloadDirty=true`, and
    // returns the same in-flight promise.
    const releaseFirst = importHook.release;
    importHook.barrier = null;
    setEnv(EC384_CERT, EC384_KEY);
    const second = mtls.reload();
    expect(second).toBe(first);

    // Release the parked first build. It will install EC256 state, then —
    // because reloadDirty is set — the do/while loop must run a second
    // iteration that re-reads the disk (now EC384) and replaces the state.
    releaseFirst();
    await Promise.all([first, second]);

    const tokAfter = await mtls.signContextJwt("admin");
    expect(decodeProtectedHeader(tokAfter).alg).toBe("ES384");
  });

  it(
    "a lease taken during an in-flight reload binds to the old state and " +
      "defers its close until release",
    async () => {
      // Regression for the unleased-window race in createMtlsRequestAuth
      // (reviewer-flagged): the helper must observe the current state and
      // increment its refcount atomically. The synchronous fast path in
      // acquireState() guarantees this; without it, a concurrent reload
      // continuation could retire+close the old state between the awaiter's
      // observation and the acquire call. This test exercises the
      // happy-path lease behaviour during a rotation as a proxy regression
      // — the precise microtask ordering that triggers the bug is not
      // deterministically reproducible from a test, but a future regression
      // would surface here as a closed-agent dispatch.
      const initial = await mtls.getAgent();
      const closeSpy = vi.spyOn(initial, "close").mockResolvedValue(undefined);

      const enteredP = new Promise<void>((r) => {
        importHook.entered = r;
      });
      importHook.barrier = new Promise<void>((r) => {
        importHook.release = r;
      });

      const reloadP = mtls.reload();
      await enteredP;

      setEnv(EC384_CERT, EC384_KEY);
      const lease = await mtls.createMtlsRequestAuth("admin");
      expect(lease.agent).toBe(initial);

      importHook.release();
      await reloadP;
      await new Promise((r) => setImmediate(r));
      expect(closeSpy).not.toHaveBeenCalled();

      lease.release();
      await new Promise((r) => setImmediate(r));
      expect(closeSpy).toHaveBeenCalledOnce();
    },
  );

  it("retired state defers close until the last lease releases", async () => {
    const lease = await mtls.createMtlsRequestAuth("admin");
    const closeSpy = vi
      .spyOn(lease.agent, "close")
      .mockResolvedValue(undefined);

    await mtls.reload();
    expect(closeSpy).not.toHaveBeenCalled();

    lease.release();
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("deferred close swallows agent.close() rejection", async () => {
    const lease = await mtls.createMtlsRequestAuth("admin");
    vi.spyOn(lease.agent, "close").mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mtls.reload();
    lease.release();
    // Wait long enough for the rejected close promise to resolve.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(
      "[mtls] failed to close retired agent",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it(
    "the active (non-retired) state is never closed by acquire/release " +
      "churn alone",
    async () => {
      const a = await mtls.getAgent();
      const closeSpy = vi.spyOn(a, "close").mockResolvedValue(undefined);

      // Acquire and release several leases against the active state without
      // any reload(). The structural refcount of 1 must never drop to 0.
      for (let i = 0; i < 5; i++) {
        const lease = await mtls.createMtlsRequestAuth("admin");
        lease.release();
      }
      await new Promise((r) => setImmediate(r));

      expect(closeSpy).not.toHaveBeenCalled();
    },
  );
});
