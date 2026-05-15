import "server-only";

/**
 * Triage baseline cadence dispatcher (#487).
 *
 * 15-minute fan-out path that the in-repo `cron` service hits exactly
 * once per tick: enumerate active customers, run one cadence pass per
 * customer with bounded concurrency + per-customer timeout, aggregate
 * the per-customer outcomes into a structured response. The
 * per-customer cadence runner remains the unit of correctness — this
 * file just orchestrates the fan-out so the crontab does not need a
 * customer list of its own.
 *
 * The dispatcher invokes the cadence runner **in-process** (no extra
 * HTTP round-trip per customer): the cron container hits exactly one
 * dispatcher endpoint, and the dispatcher fans out via direct function
 * calls. This keeps per-customer logging inside the same Node process
 * and avoids materialising a per-customer JWT/mTLS handshake we do not
 * need.
 *
 * ## Status enum
 *
 * `perCustomer[].status` is closed; see #487 §2 for the table.
 *   - `ok` / `skipped` / `failed`: forwarded verbatim from
 *     `runTriageBaselineCadence`.
 *   - `timeout`: this customer's run exceeded its effective timeout.
 *     The dispatcher aborted it and freed the concurrency slot. The
 *     runner observed the abort and rolled back the in-flight page.
 *     The effective timeout is `min(perCustomerTimeoutMs,
 *     remainingDispatcherBudget)` — when the total dispatcher
 *     deadline approaches, in-flight customers are aborted before the
 *     network-level `--max-time` in the cron wrapper would kill the
 *     whole HTTP exchange (which would discard the structured
 *     response body).
 *   - `skipped-timeout`: the dispatcher's overall timeout fired
 *     before this customer was even attempted. The next 15-minute
 *     tick picks them up via the existing watermark.
 *
 * ## `overall` derivation
 *
 *   - `ok` ⇔ every per-customer status is `ok` or `skipped`.
 *   - `partial` ⇔ at least one customer is `failed | timeout |
 *     skipped-timeout` AND the dispatcher itself completed.
 *   - `failed` is reserved for **dispatcher self-failure** (e.g.
 *     enumerating customers blew up). The route handler maps that to
 *     HTTP 500. Per-customer outcomes never escalate to `overall:
 *     'failed'` — they live in `perCustomer[]`.
 */

import {
  type CadencePager,
  type CadenceRunResult,
  runTriageBaselineCadence,
} from "@/lib/triage/baseline/cadence";
import { CustomerNotFoundError } from "@/lib/triage/policy/customer-db";

export type DispatcherPerCustomerStatus =
  | "ok"
  | "skipped"
  | "failed"
  | "timeout"
  | "skipped-timeout";

export type DispatcherOverall = "ok" | "partial" | "failed";

export interface DispatcherPerCustomerEntry {
  customerId: number;
  status: DispatcherPerCustomerStatus;
  observedInserted: number;
  baselineInserted: number;
  lastEventCursor: string | null;
  /** Populated for `failed` and `timeout`; carries the cause string. */
  error?: string;
}

export interface DispatcherResult {
  overall: DispatcherOverall;
  perCustomer: DispatcherPerCustomerEntry[];
}

export interface DispatcherOptions {
  pager: CadencePager;
  /**
   * Resolves the active-customer list. Defaults to a `SELECT id FROM
   * customers WHERE status = 'active'` against the manager DB. Tests
   * inject a fake.
   */
  listActiveCustomers?: () => Promise<number[]>;
  /**
   * Concurrency cap (per-tick). Defaults to
   * `TRIAGE_BASELINE_DISPATCH_CONCURRENCY` or 4.
   */
  concurrency?: number;
  /**
   * Per-customer hard timeout in milliseconds. Defaults to
   * `TRIAGE_BASELINE_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` or 15 minutes.
   * On timeout the runner's AbortSignal fires, the slot is freed, and
   * the per-customer entry reports `status: 'timeout'`.
   */
  perCustomerTimeoutMs?: number;
  /**
   * Total dispatcher timeout in milliseconds. Defaults to
   * `TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS` or 14 minutes — kept
   * strictly under the 15-minute cron interval so a slow tick cannot
   * overlap the next one. When the deadline passes, customers that
   * have not yet started are reported as `skipped-timeout`. The cron
   * wrapper's `--max-time` should be kept equal to this value so the
   * application-level timeout wins over the network-level timeout.
   */
  totalTimeoutMs?: number;
  /**
   * Override the cadence runner. Tests inject a fake; production
   * defaults to {@link runTriageBaselineCadence}.
   */
  runCadence?: (
    customerId: number,
    options: { pager: CadencePager; signal?: AbortSignal },
  ) => Promise<CadenceRunResult>;
  /**
   * Override the wall-clock now() used for the total-timeout
   * computation. Defaults to `Date.now()`.
   */
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_CUSTOMER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TOTAL_TIMEOUT_MS = 14 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

interface DispatchLogLine {
  message: "triage_baseline_dispatch";
  overall: DispatcherOverall;
  perCustomer: Array<{
    customerId: number;
    status: DispatcherPerCustomerStatus;
    observedInserted: number;
    baselineInserted: number;
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

function buildLogLine(result: DispatcherResult): DispatchLogLine {
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
    message: "triage_baseline_dispatch",
    overall: result.overall,
    perCustomer: result.perCustomer.map((e) => ({
      customerId: e.customerId,
      status: e.status,
      observedInserted: e.observedInserted,
      baselineInserted: e.baselineInserted,
    })),
    totalCustomers: result.perCustomer.length,
    ok,
    skipped,
    failed,
    timeout,
    skippedTimeout,
  };
}

function emitLogLine(line: DispatchLogLine): void {
  console.log(JSON.stringify(line));
}

function buildSelfFailureLogLine(error: string): DispatchLogLine {
  return {
    message: "triage_baseline_dispatch",
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

/**
 * Default active-customer enumerator. Kept in the dispatcher module so
 * tests can mock the whole `listActiveCustomers` callback without
 * stubbing `pg`.
 */
async function defaultListActiveCustomers(): Promise<number[]> {
  // Imported lazily so test harnesses that stub `listActiveCustomers`
  // never load the real `pg` client (and therefore never fail to read
  // `DATABASE_URL`).
  const { query } = await import("@/lib/db/client");
  const result = await query<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

/**
 * Race a promise against the dispatcher's abort signal. If the signal
 * fires first, reject with `reason` so the dispatcher reports a
 * self-failure (HTTP 500). The underlying promise is left to settle on
 * its own — for the default enumerator this means a hung `pg` query
 * eventually GCs once the connection closes.
 */
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
  entries: DispatcherPerCustomerEntry[],
): DispatcherOverall {
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
 * Run one dispatcher pass. Throws only when the dispatcher itself
 * cannot make per-customer attempts meaningful (e.g. customer
 * enumeration fails). Per-customer failures are reflected in the
 * returned `perCustomer[]` entry, never as a thrown error.
 */
export async function runTriageBaselineDispatch(
  options: DispatcherOptions,
): Promise<DispatcherResult> {
  const concurrency = Math.max(
    1,
    options.concurrency ??
      readPositiveIntEnv(
        "TRIAGE_BASELINE_DISPATCH_CONCURRENCY",
        DEFAULT_CONCURRENCY,
      ),
  );
  const perCustomerTimeoutMs =
    options.perCustomerTimeoutMs ??
    readPositiveIntEnv(
      "TRIAGE_BASELINE_DISPATCH_PER_CUSTOMER_TIMEOUT_MS",
      DEFAULT_PER_CUSTOMER_TIMEOUT_MS,
    );
  const totalTimeoutMs =
    options.totalTimeoutMs ??
    readPositiveIntEnv(
      "TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS",
      DEFAULT_TOTAL_TIMEOUT_MS,
    );
  const now = options.now ?? (() => Date.now());
  const runCadence = options.runCadence ?? runTriageBaselineCadence;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;

  // Start the total-timeout clock at dispatcher entry so customer
  // enumeration is bounded by the same ceiling as the fan-out. If the
  // manager DB query hangs past `totalTimeoutMs`, throw a dispatcher
  // self-failure (the route maps it to HTTP 500 with
  // `overall: 'failed'`) rather than letting the cron wrapper's
  // `--max-time` kill the HTTP exchange and discard the structured
  // response body.
  const startedAt = now();
  const deadline = startedAt + totalTimeoutMs;

  // Dispatcher-level abort. Fires when the total deadline elapses so
  // any in-flight per-customer cadence run is cancelled (its slot
  // would otherwise hold up to `perCustomerTimeoutMs` *past* the total
  // deadline, missing the cron wrapper's `--max-time` and turning a
  // structured `timeout` outcome into a transport-failure exit). This
  // is in addition to the cap on each newly-started customer's
  // effective timeout (`min(perCustomerTimeoutMs, remainingBudget)`).
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
    // Dispatcher self-failure path. Emit the same canonical structured
    // log line as the success path so monitoring keyed off
    // `triage_baseline_dispatch` (#487 §2 monitoring requirement, runbook
    // "Monitoring") observes `overall: 'failed'`. Without this, an
    // enumeration hang or error returns HTTP 500 with a structured body
    // but leaves the canonical log surface silent.
    const message = err instanceof Error ? err.message : "Dispatcher failed";
    emitLogLine(buildSelfFailureLogLine(message));
    throw err;
  }

  // Index → result slot so we can fill entries in customer-id order
  // regardless of completion order.
  const slots: (DispatcherPerCustomerEntry | null)[] = customers.map(
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
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        };
        continue;
      }

      const effectiveTimeoutMs = Math.min(
        perCustomerTimeoutMs,
        remainingBudget,
      );

      slots[i] = await runOneCustomer(
        customerId,
        runCadence,
        options.pager,
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
    (slot): slot is DispatcherPerCustomerEntry => slot !== null,
  );
  const overall = deriveOverall(perCustomer);
  const result: DispatcherResult = { overall, perCustomer };

  // Single structured log line — the canonical surface monitoring
  // keys off (#487 §2 monitoring requirement). Operators who want a
  // sidecar can stream stdout into their pipeline; the wrapper script
  // also captures the response body to a timestamped file.
  emitLogLine(buildLogLine(result));

  return result;
}

async function runOneCustomer(
  customerId: number,
  runCadence: NonNullable<DispatcherOptions["runCadence"]>,
  pager: CadencePager,
  timeoutMs: number,
  dispatcherSignal: AbortSignal,
): Promise<DispatcherPerCustomerEntry> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Propagate dispatcher-level abort (total-timeout reached) into this
  // customer's signal so any in-flight cadence call rolls back its
  // open page and returns promptly. We classify the outcome as
  // `timeout` either way — from the operator's perspective both modes
  // are "ran out of time on this run".
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
    const result = await runCadence(customerId, {
      pager,
      signal: controller.signal,
    });
    if (timedOut) {
      return {
        customerId,
        status: "timeout",
        observedInserted: result.observedInserted,
        baselineInserted: result.baselineInserted,
        lastEventCursor: result.lastEventCursor,
        error: `Per-customer timeout after ${timeoutMs}ms`,
      };
    }
    const status: DispatcherPerCustomerStatus =
      result.status === "ok"
        ? "ok"
        : result.status === "skipped"
          ? "skipped"
          : "failed";
    return {
      customerId,
      status,
      observedInserted: result.observedInserted,
      baselineInserted: result.baselineInserted,
      lastEventCursor: result.lastEventCursor,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } catch (err) {
    if (timedOut) {
      return {
        customerId,
        status: "timeout",
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
        error: `Per-customer timeout after ${timeoutMs}ms`,
      };
    }
    if (err instanceof CustomerNotFoundError) {
      // The customer was active when we enumerated but is no longer.
      // Treat as a per-customer failure: visible in `perCustomer[]`,
      // not a dispatcher self-failure.
      return {
        customerId,
        status: "failed",
        observedInserted: 0,
        baselineInserted: 0,
        lastEventCursor: null,
        error: err.message,
      };
    }
    const message = err instanceof Error ? err.message : "Cadence failed";
    return {
      customerId,
      status: "failed",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
    dispatcherSignal.removeEventListener("abort", onDispatcherAbort);
  }
}
