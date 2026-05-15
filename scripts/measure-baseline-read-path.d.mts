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
  ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

export function sampleAddresses(
  pool: SampleAddressesPool,
  periodStartIso: string,
  periodEndIso: string,
  menuCutoff?: number,
): Promise<string[]>;

export interface SpawnSyncResultLike {
  status: number | null;
}

export type ColdCommandResult =
  | { mode: "absent"; label: string }
  | { mode: "captured"; label: string }
  | { mode: "failed"; label: string };

export function runColdCommand(
  cmd: string | null | undefined,
  spawn?: (
    cmd: string,
    opts: { shell: true; stdio: "inherit" },
  ) => SpawnSyncResultLike,
): ColdCommandResult;

export interface ColdPhasePoolLike {
  connect: () => Promise<{
    query: (
      sql: string,
      params?: ReadonlyArray<unknown>,
    ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
    release: () => void;
  }>;
  end: () => Promise<void>;
}

export interface MeasuredQueryLike {
  name: string;
  sql: string;
  buildParams: (ctx: unknown) => ReadonlyArray<unknown>;
}

export interface ColdSampleRow {
  query: string;
  phase: "cold";
  sampleIndex: 0;
  elapsedMs: number;
  rowCount: number;
}

export function runColdPhase(opts: {
  coldCommand: string | null | undefined;
  queries: ReadonlyArray<MeasuredQueryLike>;
  ctx: unknown;
  makePool: () => ColdPhasePoolLike;
  spawn?: (
    cmd: string,
    opts: { shell: true; stdio: "inherit" },
  ) => SpawnSyncResultLike;
}): Promise<{ samples: ColdSampleRow[]; label: string }>;
