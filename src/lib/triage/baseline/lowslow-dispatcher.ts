import "server-only";

/**
 * Low-and-slow sweep dispatcher (issue #701).
 *
 * Hourly fan-out the in-repo `cron` service hits exactly once per tick:
 * enumerate active customers, run one low-and-slow sweep per customer
 * with bounded concurrency + per-customer timeout, aggregate the
 * outcomes into a structured response. Mirrors the baseline cadence
 * dispatcher (`./dispatcher.ts`) but with its own concurrency / timeout
 * env vars and the sweep runner (`./lowslow-sweep.ts`) as the unit of
 * correctness.
 *
 * ## Status enum
 *
 *   - `ok` / `skipped` / `failed`: forwarded from `runLowslowSweep`
 *     (`skipped` = advisory lock unavailable).
 *   - `timeout`: this customer's sweep exceeded its effective timeout
 *     (`min(perCustomerTimeoutMs, remainingBudget)`). The dispatcher
 *     aborts the runner *and* passes the budget as `timeoutMs` so the
 *     runner binds `statement_timeout` DB-side — the abort alone cannot
 *     free a slot stuck inside `client.query`, so the DB-side cancel is
 *     the hard backstop.
 *   - `skipped-timeout`: the dispatcher's overall timeout fired before
 *     this customer was attempted; the next hourly tick picks them up
 *     via the watermark.
 *
 * ## `overall` derivation
 *
 *   - `ok` ⇔ every per-customer status is `ok` or `skipped`.
 *   - `partial` ⇔ at least one customer is `failed | timeout |
 *     skipped-timeout` AND the dispatcher itself completed.
 *   - `failed` is reserved for dispatcher self-failure (customer
 *     enumeration blew up); the route maps it to HTTP 500.
 */

import { listActiveCustomers as defaultListActiveCustomers } from "@/lib/triage/baseline/active-customers";
import {
  type LowslowSweepResult,
  runLowslowSweep,
} from "@/lib/triage/baseline/lowslow-sweep";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

export type LowslowDispatcherPerCustomerStatus =
  | "ok"
  | "skipped"
  | "failed"
  | "timeout"
  | "skipped-timeout";

export type LowslowDispatcherOverall = "ok" | "partial" | "failed";

export interface LowslowDispatcherPerCustomerEntry {
  customerId: number;
  status: LowslowDispatcherPerCustomerStatus;
  storiesInserted: number;
  /** Populated for `failed` and `timeout`; carries the cause string. */
  error?: string;
}

export interface LowslowDispatcherResult {
  overall: LowslowDispatcherOverall;
  perCustomer: LowslowDispatcherPerCustomerEntry[];
}

export interface LowslowDispatcherOptions {
  /**
   * Resolves the active-customer list. Defaults to the shared
   * `SELECT id FROM customers WHERE status = 'active'` enumerator.
   * Tests inject a fake.
   */
  listActiveCustomers?: () => Promise<number[]>;
  /**
   * Concurrency cap (per-tick). Defaults to
   * `LOWSLOW_SWEEP_DISPATCH_CONCURRENCY` or 4.
   */
  concurrency?: number;
  /**
   * Per-customer hard timeout in milliseconds. Defaults to
   * `LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` or 15 minutes.
   */
  perCustomerTimeoutMs?: number;
  /**
   * Total dispatcher timeout in milliseconds. Defaults to
   * `LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` or 55 minutes — kept
   * strictly under the 60-minute cron interval so a slow tick cannot
   * overlap the next one. Any resolved value above
   * `MAX_TOTAL_TIMEOUT_MS` (55 minutes) is clamped down with a warn
   * log. The cron wrapper's `--max-time` should equal this value so
   * the application-level timeout wins over the network-level one.
   */
  totalTimeoutMs?: number;
  /** Override the sweep runner. Tests inject a fake. */
  runSweep?: (
    customerId: number,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<LowslowSweepResult>;
  /** Override `now()`. Defaults to `Date.now()`. */
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_CUSTOMER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TOTAL_TIMEOUT_MS = 55 * 60 * 1000;
// Hard ceiling for `totalTimeoutMs`. The cron tick fires hourly
// (3_600_000ms); a dispatcher run that exceeds 55 minutes risks
// overlapping the next tick. Clamp at the default so a stale override
// cannot silently re-introduce overlap.
const MAX_TOTAL_TIMEOUT_MS = 55 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

interface LowslowDispatchLogLine {
  message: "triage_lowslow_sweep_dispatch";
  overall: LowslowDispatcherOverall;
  perCustomer: Array<{
    customerId: number;
    status: LowslowDispatcherPerCustomerStatus;
    storiesInserted: number;
  }>;
  totalCustomers: number;
  ok: number;
  skipped: number;
  failed: number;
  timeout: number;
  skippedTimeout: number;
  /** Populated only on dispatcher self-failure (`overall: 'failed'`). */
  error?: string;
}

function buildLogLine(result: LowslowDispatcherResult): LowslowDispatchLogLine {
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let timeout = 0;
  let skippedTimeout = 0;
  for (const entry of result.perCustomer) {
    switch (entry.status) {
      case "ok":
        ok += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "timeout":
        timeout += 1;
        break;
      case "skipped-timeout":
        skippedTimeout += 1;
        break;
    }
  }
  return {
    message: "triage_lowslow_sweep_dispatch",
    overall: result.overall,
    perCustomer: result.perCustomer.map((e) => ({
      customerId: e.customerId,
      status: e.status,
      storiesInserted: e.storiesInserted,
    })),
    totalCustomers: result.perCustomer.length,
    ok,
    skipped,
    failed,
    timeout,
    skippedTimeout,
  };
}

function emitLogLine(line: LowslowDispatchLogLine): void {
  console.log(JSON.stringify(line));
}

function buildSelfFailureLogLine(error: string): LowslowDispatchLogLine {
  return {
    message: "triage_lowslow_sweep_dispatch",
    overall: "failed",
    perCustomer: [],
    totalCustomers: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
    timeout: 0,
    skippedTimeout: 0,
    error,
  };
}

function raceAgainstDispatcherAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  reason: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function deriveOverall(
  entries: LowslowDispatcherPerCustomerEntry[],
): LowslowDispatcherOverall {
  for (const entry of entries) {
    if (
      entry.status === "failed" ||
      entry.status === "timeout" ||
      entry.status === "skipped-timeout"
    ) {
      return "partial";
    }
  }
  return "ok";
}

/**
 * Run one low-and-slow dispatcher pass. Throws only when the
 * dispatcher itself cannot make per-customer attempts meaningful (e.g.
 * customer enumeration fails). Per-customer failures are reflected in
 * the returned `perCustomer[]` entry, never as a thrown error.
 */
export async function runLowslowSweepDispatch(
  options: LowslowDispatcherOptions = {},
): Promise<LowslowDispatcherResult> {
  const concurrency = Math.max(
    1,
    options.concurrency ??
      readPositiveIntEnv(
        "LOWSLOW_SWEEP_DISPATCH_CONCURRENCY",
        DEFAULT_CONCURRENCY,
      ),
  );
  const perCustomerTimeoutMs =
    options.perCustomerTimeoutMs ??
    readPositiveIntEnv(
      "LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS",
      DEFAULT_PER_CUSTOMER_TIMEOUT_MS,
    );
  const rawTotalTimeoutMs =
    options.totalTimeoutMs ??
    readPositiveIntEnv(
      "LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS",
      DEFAULT_TOTAL_TIMEOUT_MS,
    );
  const totalTimeoutMs = Math.min(rawTotalTimeoutMs, MAX_TOTAL_TIMEOUT_MS);
  if (totalTimeoutMs !== rawTotalTimeoutMs) {
    console.warn(
      `triage_lowslow_sweep_dispatch: total timeout ${rawTotalTimeoutMs}ms exceeds the cron-interval-safe ceiling ${MAX_TOTAL_TIMEOUT_MS}ms; clamping to ${MAX_TOTAL_TIMEOUT_MS}ms so a slow tick cannot overlap the next one`,
    );
  }
  const now = options.now ?? (() => Date.now());
  const runSweep = options.runSweep ?? runLowslowSweep;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;

  const startedAt = now();
  const deadline = startedAt + totalTimeoutMs;

  const dispatcherController = new AbortController();
  const dispatcherTimer = setTimeout(
    () => dispatcherController.abort(),
    Math.max(0, totalTimeoutMs),
  );

  let customers: number[];
  try {
    customers = await raceAgainstDispatcherAbort(
      listActiveCustomers(),
      dispatcherController.signal,
      `Customer enumeration exceeded total dispatcher timeout (${totalTimeoutMs}ms)`,
    );
  } catch (err) {
    clearTimeout(dispatcherTimer);
    const message = err instanceof Error ? err.message : "Dispatcher failed";
    emitLogLine(buildSelfFailureLogLine(message));
    throw err;
  }

  const slots: (LowslowDispatcherPerCustomerEntry | null)[] = customers.map(
    () => null,
  );
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      if (i >= customers.length) return;
      nextIndex = i + 1;

      const customerId = customers[i];

      const remainingBudget = deadline - now();
      if (remainingBudget <= 0) {
        slots[i] = {
          customerId,
          status: "skipped-timeout",
          storiesInserted: 0,
        };
        continue;
      }

      const effectiveTimeoutMs = Math.min(
        perCustomerTimeoutMs,
        remainingBudget,
      );
      slots[i] = await runOneCustomer(
        customerId,
        runSweep,
        effectiveTimeoutMs,
        dispatcherController.signal,
      );
    }
  }

  try {
    const workerCount = Math.min(concurrency, Math.max(customers.length, 1));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w += 1) workers.push(worker());
    await Promise.all(workers);
  } finally {
    clearTimeout(dispatcherTimer);
  }

  const perCustomer = slots.filter(
    (slot): slot is LowslowDispatcherPerCustomerEntry => slot !== null,
  );
  const overall = deriveOverall(perCustomer);
  const result: LowslowDispatcherResult = { overall, perCustomer };

  emitLogLine(buildLogLine(result));
  return result;
}

async function runOneCustomer(
  customerId: number,
  runSweep: NonNullable<LowslowDispatcherOptions["runSweep"]>,
  timeoutMs: number,
  dispatcherSignal: AbortSignal,
): Promise<LowslowDispatcherPerCustomerEntry> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onDispatcherAbort = () => {
    timedOut = true;
    controller.abort();
  };
  if (dispatcherSignal.aborted) {
    onDispatcherAbort();
  } else {
    dispatcherSignal.addEventListener("abort", onDispatcherAbort, {
      once: true,
    });
  }

  try {
    // Pass the effective budget so the runner can enforce it DB-side
    // (`SET LOCAL statement_timeout`). The `AbortSignal` alone cannot
    // bound a runner stuck inside `client.query`; the timeout is the
    // hard backstop that frees this worker slot.
    const result = await runSweep(customerId, {
      signal: controller.signal,
      timeoutMs,
    });
    if (timedOut) {
      return {
        customerId,
        status: "timeout",
        storiesInserted: result.storiesInserted,
        error: `Per-customer timeout after ${timeoutMs}ms`,
      };
    }
    const status: LowslowDispatcherPerCustomerStatus =
      result.status === "ok"
        ? "ok"
        : result.status === "skipped"
          ? "skipped"
          : "failed";
    return {
      customerId,
      status,
      storiesInserted: result.storiesInserted,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } catch (err) {
    if (timedOut) {
      return {
        customerId,
        status: "timeout",
        storiesInserted: 0,
        error: `Per-customer timeout after ${timeoutMs}ms`,
      };
    }
    if (err instanceof CustomerNotFoundError) {
      return {
        customerId,
        status: "failed",
        storiesInserted: 0,
        error: err.message,
      };
    }
    const message = err instanceof Error ? err.message : "Sweep failed";
    return {
      customerId,
      status: "failed",
      storiesInserted: 0,
      error: message,
    };
  } finally {
    clearTimeout(timer);
    dispatcherSignal.removeEventListener("abort", onDispatcherAbort);
  }
}
