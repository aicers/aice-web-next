import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DrainResult } from "@/lib/aimer/phase2/transport.client";

const mockDrain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/transport.client", () => ({
  drainOpportunisticPushQueue: mockDrain,
}));

import {
  __resetDrainCoordinatorForTests,
  coordinatedDrain,
} from "@/lib/aimer/phase2/drain-coordinator.client";

function result(delivered: number): DrainResult {
  return {
    totalDelivered: delivered,
    totalNoOp: 0,
    batches: 1,
    stoppedReason: "exhausted",
  } as unknown as DrainResult;
}

/** A drain whose resolution is controlled by the returned `resolve`. */
function deferredDrain(): {
  promise: Promise<DrainResult>;
  resolve: (r: DrainResult) => void;
} {
  let resolve!: (r: DrainResult) => void;
  const promise = new Promise<DrainResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("coordinatedDrain", () => {
  beforeEach(() => {
    mockDrain.mockReset();
    __resetDrainCoordinatorForTests();
  });
  afterEach(() => {
    __resetDrainCoordinatorForTests();
  });

  it("joins a concurrent call for the same (kind, customer) into one drain", async () => {
    const d = deferredDrain();
    mockDrain.mockReturnValueOnce(d.promise);

    const a = coordinatedDrain("story", 42);
    const b = coordinatedDrain("story", 42);

    // Both callers share the single in-flight promise — only one drain ran.
    expect(mockDrain).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);

    d.resolve(result(5));
    await expect(a).resolves.toBe(await b);
  });

  it("runs separate drains for different kinds of the same customer", () => {
    mockDrain.mockReturnValue(deferredDrain().promise);
    coordinatedDrain("story", 42);
    coordinatedDrain("baseline_event", 42);
    expect(mockDrain).toHaveBeenCalledTimes(2);
  });

  it("runs separate drains for different customers of the same kind", () => {
    mockDrain.mockReturnValue(deferredDrain().promise);
    coordinatedDrain("story", 1);
    coordinatedDrain("story", 2);
    expect(mockDrain).toHaveBeenCalledTimes(2);
  });

  it("clears the registry after a drain settles so a later call re-drains", async () => {
    const first = deferredDrain();
    mockDrain.mockReturnValueOnce(first.promise);
    const a = coordinatedDrain("story", 42);
    first.resolve(result(1));
    await a;

    const second = deferredDrain();
    mockDrain.mockReturnValueOnce(second.promise);
    coordinatedDrain("story", 42);
    expect(mockDrain).toHaveBeenCalledTimes(2);
    second.resolve(result(0));
  });

  it("clears the registry even when the drain rejects", async () => {
    mockDrain.mockRejectedValueOnce(new Error("network"));
    await expect(coordinatedDrain("story", 42)).rejects.toThrow("network");

    mockDrain.mockReturnValueOnce(deferredDrain().promise);
    coordinatedDrain("story", 42);
    expect(mockDrain).toHaveBeenCalledTimes(2);
  });
});
