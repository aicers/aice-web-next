// Type declarations for `seed-baseline-corpus-for-measurement.mjs`.
// Authored as a sibling `.d.mts` so tests can import the pure helpers
// with full IDE / typecheck signal without forcing the script through
// a transpile step.

import type pg from "pg";

export interface ParsedSeedArgs {
  connectionString: string;
  baselineRows: number;
  observedRows: number;
  days: number;
  origAddrs: number;
  seed: number;
  anchorTime: string | null;
  reset: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedSeedArgs;

export function mulberry32(seed: number): () => number;

export function resolveAnchorMs(
  anchorTime: string | null,
  nowMs: number,
): number;

export function buildAddressPool(count: number): string[];

export function buildAddressCumulative(count: number): Float64Array;

export function buildKindCumulative(): Float64Array;

export function pickIndexFromU(u: number, cumulative: Float64Array): number;

export function buildSelectorTags(
  uCount: number,
  uOffset: number,
  uUnlabeled: number,
  baselineVersion: string,
  kindName: string,
): string[];

export function redactDsn(dsn: string): string;

export interface SeedClient {
  query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

export interface SeedCorpusOptions {
  client: SeedClient;
  observedRows: number;
  baselineRows: number;
  days: number;
  origAddrs: number;
  seed: number;
  anchorMs: number;
  exclusionsFp: string;
  log?: (message: string) => void;
}

export function seedCorpus(opts: SeedCorpusOptions): Promise<{
  observedInserted: number;
  baselineInserted: number;
  elapsedMs: number;
}>;

export function preflightOrReset(
  client: SeedClient,
  reset: boolean,
  log?: (message: string) => void,
): Promise<void>;

export interface UpdateCorpusStateOptions {
  client: SeedClient;
  anchorMs: number;
  days: number;
  exclusionsFp: string;
}

export function updateCorpusState(
  opts: UpdateCorpusStateOptions,
): Promise<void>;

export function vacuumAnalyzeCorpus(
  pool: pg.Pool,
  log?: (message: string) => void,
): Promise<void>;
