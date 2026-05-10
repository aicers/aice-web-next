import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockCustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

vi.mock("@/lib/triage/policy/customer-db", () => ({
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

const FAKE_PAGER = { ingestPage: vi.fn() } as unknown as Parameters<
  typeof import("@/lib/triage/baseline/dispatcher").runTriageBaselineDispatch
>[0]["pager"];

const ENV_KEYS = [
  "TRIAGE_BASELINE_DISPATCH_CONCURRENCY",
  "TRIAGE_BASELINE_DISPATCH_PER_CUSTOMER_TIMEOUT_MS",
  "TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS",
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

describe("runTriageBaselineDispatch — overall derivation", () => {
  it("returns overall=ok when every per-customer status is ok or skipped", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    const runCadence = vi.fn(async (customerId: number) => ({
      customerId,
      status: customerId % 2 === 0 ? ("ok" as const) : ("skipped" as const),
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    }));
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2, 3, 4],
      runCadence,
    });
    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toHaveLength(4);
  });

  it("returns overall=partial when at least one customer fails", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    const runCadence = vi.fn(async (customerId: number) => {
      if (customerId === 2) {
        return {
          customerId,
          status: "failed" as const,
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
          error: "cadence rollback",
        };
      }
      return {
        customerId,
        status: "ok" as const,
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
      };
    });
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2, 3],
      runCadence,
    });
    expect(result.overall).toBe("partial");
    const failed = result.perCustomer.find((e) => e.customerId === 2);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("cadence rollback");
  });

  it("propagates dispatcher self-failure as a thrown error (the route maps it to 500)", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    await expect(
      runTriageBaselineDispatch({
        pager: FAKE_PAGER,
        listActiveCustomers: async () => {
          throw new Error("enumeration failed");
        },
      }),
    ).rejects.toThrow("enumeration failed");
  });

  it("treats a customer enumeration that exceeds the total dispatcher timeout as self-failure (Round 3 fix)", async () => {
    // Regression: previously `listActiveCustomers()` ran outside the
    // total-timeout clock. A hung manager DB query would let the cron
    // wrapper's `--max-time` kill the HTTP exchange first, dropping the
    // structured `{ overall: 'failed', ... }` body. The total budget
    // must start at dispatcher entry and bound enumeration too.
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    const startedAt = Date.now();
    await expect(
      runTriageBaselineDispatch({
        pager: FAKE_PAGER,
        // Never resolves — must be aborted by the total-timeout clock.
        listActiveCustomers: () => new Promise<number[]>(() => {}),
        totalTimeoutMs: 80,
      }),
    ).rejects.toThrow(/Customer enumeration exceeded total dispatcher timeout/);
    const elapsed = Date.now() - startedAt;
    // Must give up close to totalTimeoutMs, not hang indefinitely.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("runTriageBaselineDispatch — per-customer non-2xx normalisation", () => {
  it("a runner-thrown error normalises to status=failed without escalating overall to failed", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    const runCadence = vi.fn(async (customerId: number) => {
      if (customerId === 7) throw new Error("transport: connection refused");
      return {
        customerId,
        status: "ok" as const,
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
      };
    });
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [7, 8],
      runCadence,
    });
    expect(result.overall).toBe("partial");
    const seven = result.perCustomer.find((e) => e.customerId === 7);
    expect(seven?.status).toBe("failed");
    expect(seven?.error).toContain("transport: connection refused");
  });

  it("a CustomerNotFoundError thrown mid-fan-out is reported as status=failed, not dispatcher self-failure", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    const runCadence = vi.fn(async (customerId: number) => {
      if (customerId === 9) throw new MockCustomerNotFoundError(9);
      return {
        customerId,
        status: "ok" as const,
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
      };
    });
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [9, 10],
      runCadence,
    });
    expect(result.overall).toBe("partial");
    const nine = result.perCustomer.find((e) => e.customerId === 9);
    expect(nine?.status).toBe("failed");
  });
});

describe("runTriageBaselineDispatch — concurrency", () => {
  it("never runs more than `concurrency` per-customer invocations in parallel", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const runCadence = vi.fn(async (customerId: number) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      inFlight -= 1;
      return {
        customerId,
        status: "ok" as const,
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
      };
    });

    const customers = Array.from({ length: 10 }, (_, i) => i + 1);
    const promise = runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => customers,
      runCadence,
      concurrency: 4,
    });

    // Drain pending tasks: release all in-flight runs sequentially.
    while (release.length > 0 || (await runCadence.mock.results).length < 10) {
      await Promise.resolve();
      await Promise.resolve();
      while (release.length > 0) {
        const r = release.shift();
        r?.();
        await Promise.resolve();
      }
      if (runCadence.mock.calls.length >= 10 && release.length === 0) break;
    }

    const result = await promise;
    expect(result.overall).toBe("ok");
    expect(result.perCustomer).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("runTriageBaselineDispatch — per-customer timeout", () => {
  it("aborts via AbortSignal, reports status=timeout, and frees the slot for the next customer", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    let observedAbort = false;
    let releasedAt: number | null = null;
    let secondStartedAt: number | null = null;
    const startedAt = Date.now();

    const runCadence = vi.fn(
      async (
        customerId: number,
        opts: { signal?: AbortSignal },
      ): Promise<{
        customerId: number;
        status: "ok" | "skipped" | "failed";
        observedInserted: number;
        baselineInserted: number;
        lastEventCursor: string | null;
        error?: string;
      }> => {
        if (customerId === 1) {
          // Stuck: only resolves when aborted.
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => {
              observedAbort = true;
              releasedAt = Date.now() - startedAt;
              resolve();
            });
          });
          return {
            customerId,
            status: "ok",
            observedInserted: 0,
            baselineInserted: 0,
            lastEventCursor: null,
          };
        }
        secondStartedAt = Date.now() - startedAt;
        return {
          customerId,
          status: "ok",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        };
      },
    );

    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2],
      runCadence,
      perCustomerTimeoutMs: 80,
      // Run sequentially so we can prove the slot is released after
      // timeout (otherwise customer 2 could start while customer 1 is
      // still pending in a parallel slot).
      concurrency: 1,
    });

    const one = result.perCustomer.find((e) => e.customerId === 1);
    const two = result.perCustomer.find((e) => e.customerId === 2);
    expect(one?.status).toBe("timeout");
    expect(two?.status).toBe("ok");
    expect(observedAbort).toBe(true);
    expect(releasedAt).not.toBeNull();
    // Customer 2 must start AFTER customer 1's slot was released.
    expect(secondStartedAt).not.toBeNull();
    expect(secondStartedAt as unknown as number).toBeGreaterThanOrEqual(
      releasedAt as unknown as number,
    );
  });
});

describe("runTriageBaselineDispatch — total timeout", () => {
  it("aborts in-flight customers when the dispatcher deadline elapses (does not wait for per-customer timeout to expire after deadline)", async () => {
    // Regression: previously a customer started just before the total
    // deadline could keep its full perCustomerTimeoutMs slot, blowing
    // past the dispatcher's own ceiling. The cron wrapper's
    // `--max-time` would then kill the HTTP exchange before this
    // dispatcher returned, dropping the structured response body.
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    const observedAborts: number[] = [];
    const runCadence = vi.fn(
      async (
        customerId: number,
        opts: { signal?: AbortSignal },
      ): Promise<{
        customerId: number;
        status: "ok" | "skipped" | "failed";
        observedInserted: number;
        baselineInserted: number;
        lastEventCursor: string | null;
        error?: string;
      }> => {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            observedAborts.push(customerId);
            resolve();
          });
        });
        return {
          customerId,
          status: "ok",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        };
      },
    );

    const startedAt = Date.now();
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2],
      runCadence,
      // Per-customer is far longer than total — without dispatcher-
      // level abort, the in-flight customers would hold their slots
      // for the full perCustomerTimeoutMs.
      perCustomerTimeoutMs: 60_000,
      totalTimeoutMs: 80,
      concurrency: 2,
    });
    const elapsed = Date.now() - startedAt;

    // The dispatcher must return close to totalTimeoutMs, NOT
    // perCustomerTimeoutMs.
    expect(elapsed).toBeLessThan(2000);
    // Both in-flight customers observed the abort.
    expect(observedAborts.sort()).toEqual([1, 2]);
    // Both are reported as `timeout`, not lost as transport failure.
    const one = result.perCustomer.find((e) => e.customerId === 1);
    const two = result.perCustomer.find((e) => e.customerId === 2);
    expect(one?.status).toBe("timeout");
    expect(two?.status).toBe("timeout");
    expect(result.overall).toBe("partial");
  });

  it("caps a newly-started customer's effective timeout to the remaining dispatcher budget", async () => {
    // With concurrency=1 and a short total budget, the second
    // customer's effective per-customer timeout is the remaining
    // budget, not the full perCustomerTimeoutMs.
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    let secondAborted = false;
    const runCadence = vi.fn(
      async (
        customerId: number,
        opts: { signal?: AbortSignal },
      ): Promise<{
        customerId: number;
        status: "ok" | "skipped" | "failed";
        observedInserted: number;
        baselineInserted: number;
        lastEventCursor: string | null;
        error?: string;
      }> => {
        if (customerId === 1) {
          // Burns most of the dispatcher budget but completes ok.
          await new Promise((r) => setTimeout(r, 60));
          return {
            customerId,
            status: "ok",
            observedInserted: 0,
            baselineInserted: 0,
            lastEventCursor: null,
          };
        }
        // Customer 2 hangs — only the *remaining* budget should bound
        // it, not the full perCustomerTimeoutMs.
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            secondAborted = true;
            resolve();
          });
        });
        return {
          customerId,
          status: "ok",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        };
      },
    );

    const startedAt = Date.now();
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2],
      runCadence,
      perCustomerTimeoutMs: 60_000,
      totalTimeoutMs: 100,
      concurrency: 1,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(secondAborted).toBe(true);
    const two = result.perCustomer.find((e) => e.customerId === 2);
    expect(two?.status).toBe("timeout");
  });

  it("reports unattempted customers as skipped-timeout when the overall deadline elapses", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    let virtualTime = 0;
    const advanceMs = 500;
    const runCadence = vi.fn(async (customerId: number) => {
      virtualTime += advanceMs;
      return {
        customerId,
        status: "ok" as const,
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
      };
    });

    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [1, 2, 3, 4, 5],
      runCadence,
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
});

describe("runTriageBaselineDispatch — structured log line", () => {
  it("emits a single console.log JSON line with overall + per-customer counters", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runTriageBaselineDispatch({
        pager: FAKE_PAGER,
        listActiveCustomers: async () => [1, 2],
        runCadence: async (customerId) => ({
          customerId,
          status: "ok" as const,
          observedInserted: customerId * 10,
          baselineInserted: customerId,
          lastEventCursor: null,
        }),
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.message).toBe("triage_baseline_dispatch");
      expect(parsed.overall).toBe("ok");
      expect(parsed.totalCustomers).toBe(2);
      expect(parsed.ok).toBe(2);
      expect(Array.isArray(parsed.perCustomer)).toBe(true);
      expect(parsed.perCustomer[0].customerId).toBe(1);
      expect(parsed.perCustomer[0].status).toBe("ok");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runTriageBaselineDispatch — active-customer enumeration", () => {
  it("only enumerates active customers (verified via the listActiveCustomers contract)", async () => {
    const { runTriageBaselineDispatch } = await import(
      "@/lib/triage/baseline/dispatcher"
    );
    // The default enumerator is `SELECT id FROM customers WHERE
    // status = 'active'`. We assert that the dispatcher only invokes
    // the runner for ids the enumerator returned.
    const runCadence = vi.fn(async (customerId: number) => ({
      customerId,
      status: "ok" as const,
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    }));
    const result = await runTriageBaselineDispatch({
      pager: FAKE_PAGER,
      listActiveCustomers: async () => [42],
      runCadence,
    });
    expect(runCadence).toHaveBeenCalledTimes(1);
    expect(runCadence).toHaveBeenCalledWith(42, expect.any(Object));
    expect(result.perCustomer.map((e) => e.customerId)).toEqual([42]);
  });
});
