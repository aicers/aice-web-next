// Type declarations for `measure-baseline-read-path.mjs`. Authored as
// a sibling `.d.ts` so the tests can import the helpers with full
// IDE / typecheck signal without forcing the harness through a
// transpile step.

export function resolveWindow(
  spec: string,
  nowMs?: number,
): { periodStartIso: string; periodEndIso: string };

export function redactDsn(dsn: string): string;

export function parseExplainAnalyze(planText: string): {
  elapsedMs: number;
  rowCount: number;
};

export interface SampleAddressesPool {
  query: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Promise<{
    rows: ReadonlyArray<{ orig_addr: string | null | undefined }>;
  }>;
}

export function sampleAddresses(
  pool: SampleAddressesPool,
  periodStartIso: string,
  periodEndIso: string,
  limit: number,
): Promise<string[]>;
