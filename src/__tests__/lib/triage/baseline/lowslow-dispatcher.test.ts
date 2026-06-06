import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Defined via `vi.hoisted` so the class is initialized before the
// hoisted `vi.mock` factory (and the static dispatcher import that
// triggers it) runs — a plain `class` declaration would still be in
// its temporal dead zone at that point.
const { MockCustomerNotFoundError } = vi.hoisted(() => ({
  MockCustomerNotFoundError: class MockCustomerNotFoundError extends Error {
    constructor(customerId: number) {
      super(`Customer ${customerId} not found or not active`);
      this.name = "CustomerNotFoundError";
    }
  },
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

import { runLowslowSweepDispatch } from "@/lib/triage/baseline/lowslow-dispatcher";
import type { LowslowSweepResult } from "@/lib/triage/baseline/lowslow-sweep";

function okResult(customerId: number): LowslowSweepResult {
  return {
    customerId,
    status: "ok",
    storiesInserted: 0,
    newWatermark: null,
  };
}

const ENV_KEYS = [
  "LOWSLOW_SWEEP_DISPATCH_CONCURRENCY",
  "LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS",
  "LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS",
];
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = SAVED_ENV[key];
    }
  }
});

describe("runLowslowSweepDispatch — overall derivation", () => {
  it("returns overall=ok when every per-customer status is ok or skipped", async () => {
    const runSweep = vi.fn(async (customerId: number) =>
      customerId % 2 === 0
        ? okResult(customerId)
        : ({
            customerId,
            status: "skipped" as const,
            storiesInserted: 0,
            newWatermark: null,
          } satisfies LowslowSweepResult),
    );
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [1, 2, 3, 4],
      runSweep,
    });
    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toHaveLength(4);
  });

  it("returns overall=partial when at least one customer fails", async () => {
    const runSweep = vi.fn(async (customerId: number) => {
      if (customerId === 2) {
        return {
          customerId,
          status: "failed" as const,
          storiesInserted: 0,
          newWatermark: null,
          error: "sweep rollback",
        } satisfies LowslowSweepResult;
      }
      return okResult(customerId);
    });
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [1, 2, 3],
      runSweep,
    });
    expect(result.overall).toBe("partial");
    const failed = result.perCustomer.find((e) => e.customerId === 2);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("sweep rollback");
  });

  it("propagates dispatcher self-failure as a thrown error (the route maps it to 500)", async () => {
    await expect(
      runLowslowSweepDispatch({
        listActiveCustomers: async () => {
          throw new Error("enumeration failed");
        },
      }),
    ).rejects.toThrow("enumeration failed");
  });
});

describe("runLowslowSweepDispatch — per-customer normalisation", () => {
  it("a runner-thrown error normalises to status=failed without escalating overall to failed", async () => {
    const runSweep = vi.fn(async (customerId: number) => {
      if (customerId === 7) throw new Error("transport: connection refused");
      return okResult(customerId);
    });
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [7, 8],
      runSweep,
    });
    expect(result.overall).toBe("partial");
    const seven = result.perCustomer.find((e) => e.customerId === 7);
    expect(seven?.status).toBe("failed");
    expect(seven?.error).toContain("transport: connection refused");
  });

  it("a CustomerNotFoundError thrown mid-fan-out is reported as status=failed, not dispatcher self-failure", async () => {
    const runSweep = vi.fn(async (customerId: number) => {
      if (customerId === 9) throw new MockCustomerNotFoundError(9);
      return okResult(customerId);
    });
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [9, 10],
      runSweep,
    });
    expect(result.overall).toBe("partial");
    const nine = result.perCustomer.find((e) => e.customerId === 9);
    expect(nine?.status).toBe("failed");
  });

  it("forwards storiesInserted from the sweep runner into the per-customer entry", async () => {
    const runSweep = vi.fn(async (customerId: number) => ({
      customerId,
      status: "ok" as const,
      storiesInserted: customerId,
      newWatermark: null,
    }));
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [3],
      runSweep,
    });
    expect(result.perCustomer[0].storiesInserted).toBe(3);
  });
});

describe("runLowslowSweepDispatch — total timeout", () => {
  it("reports unattempted customers as skipped-timeout when the overall deadline elapses", async () => {
    let virtualTime = 0;
    const advanceMs = 500;
    const runSweep = vi.fn(async (customerId: number) => {
      virtualTime += advanceMs;
      return okResult(customerId);
    });

    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [1, 2, 3, 4, 5],
      runSweep,
      concurrency: 1,
      totalTimeoutMs: 1000,
      now: () => virtualTime,
    });

    const skipped = result.perCustomer.filter(
      (e) => e.status === "skipped-timeout",
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(result.overall).toBe("partial");
  });

  it("aborts in-flight customers when the dispatcher deadline elapses and reports them as timeout", async () => {
    const observedAborts: number[] = [];
    const runSweep = vi.fn(
      async (
        customerId: number,
        opts: { signal?: AbortSignal },
      ): Promise<LowslowSweepResult> => {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            observedAborts.push(customerId);
            resolve();
          });
        });
        return okResult(customerId);
      },
    );

    const startedAt = Date.now();
    const result = await runLowslowSweepDispatch({
      listActiveCustomers: async () => [1, 2],
      runSweep,
      perCustomerTimeoutMs: 60_000,
      totalTimeoutMs: 80,
      concurrency: 2,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(observedAborts.sort()).toEqual([1, 2]);
    const one = result.perCustomer.find((e) => e.customerId === 1);
    const two = result.perCustomer.find((e) => e.customerId === 2);
    expect(one?.status).toBe("timeout");
    expect(two?.status).toBe("timeout");
    expect(result.overall).toBe("partial");
  });
});

describe("runLowslowSweepDispatch — total-timeout clamp", () => {
  it("clamps a totalTimeoutMs above 55 minutes to the cron-interval-safe ceiling and warns", async () => {
    // The hourly cron interval is 60 minutes; a resolved total timeout
    // above 55 minutes risks overlapping the next tick. The dispatcher
    // caps it at 3_300_000ms (55min) and warns so a stale override is
    // visible in cron logs.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLowslowSweepDispatch({
        listActiveCustomers: async () => [1],
        runSweep: async (customerId) => okResult(customerId),
        totalTimeoutMs: 4_000_000,
      });
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toMatch(/4000000ms exceeds/);
      expect(warned).toMatch(/clamping to 3300000ms/);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does not warn when the resolved total timeout is at or below the ceiling", async () => {
    process.env.LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS = "600000";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLowslowSweepDispatch({
        listActiveCustomers: async () => [1],
        runSweep: async (customerId) => okResult(customerId),
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("runLowslowSweepDispatch — structured log line", () => {
  it("emits a single console.log JSON line tagged triage_lowslow_sweep_dispatch with counters", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLowslowSweepDispatch({
        listActiveCustomers: async () => [1, 2],
        runSweep: async (customerId) => ({
          customerId,
          status: "ok" as const,
          storiesInserted: customerId,
          newWatermark: null,
        }),
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.message).toBe("triage_lowslow_sweep_dispatch");
      expect(parsed.overall).toBe("ok");
      expect(parsed.totalCustomers).toBe(2);
      expect(parsed.ok).toBe(2);
      expect(parsed.perCustomer[0].customerId).toBe(1);
      expect(parsed.perCustomer[0].storiesInserted).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits the same structured log line on dispatcher self-failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        runLowslowSweepDispatch({
          listActiveCustomers: async () => {
            throw new Error("enumeration boom");
          },
        }),
      ).rejects.toThrow("enumeration boom");
      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.message).toBe("triage_lowslow_sweep_dispatch");
      expect(parsed.overall).toBe("failed");
      expect(parsed.perCustomer).toEqual([]);
      expect(parsed.error).toBe("enumeration boom");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runLowslowSweepDispatch — concurrency", () => {
  it("never runs more than `concurrency` per-customer sweeps in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const runSweep = vi.fn(async (customerId: number) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      inFlight -= 1;
      return okResult(customerId);
    });

    const customers = Array.from({ length: 10 }, (_, i) => i + 1);
    const promise = runLowslowSweepDispatch({
      listActiveCustomers: async () => customers,
      runSweep,
      concurrency: 4,
    });

    while (release.length > 0 || runSweep.mock.calls.length < 10) {
      await Promise.resolve();
      await Promise.resolve();
      while (release.length > 0) {
        const r = release.shift();
        r?.();
        await Promise.resolve();
      }
      if (runSweep.mock.calls.length >= 10 && release.length === 0) break;
    }

    const result = await promise;
    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("runLowslowSweepDispatch — default enumerator wiring", () => {
  it("uses the shared listActiveCustomers when no override is supplied", async () => {
    // The default enumerator pulls from `@/lib/db/client` (mocked here
    // to return two ids), proving the dispatcher is wired to the shared
    // active-customer module rather than a copied query.
    const dbClient = await import("@/lib/db/client");
    (dbClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 11 }, { id: 12 }],
    });
    const runSweep = vi.fn(async (customerId: number) => okResult(customerId));
    const result = await runLowslowSweepDispatch({ runSweep });
    expect(result.perCustomer.map((e) => e.customerId).sort()).toEqual([
      11, 12,
    ]);
  });
});
