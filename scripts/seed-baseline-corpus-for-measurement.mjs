#!/usr/bin/env node
// Phase 1.B baseline corpus seed script for measurement reproducibility
// (issue #540). Writes a deterministic, profile-conformant corpus into
// `baseline_triaged_event`, `observed_event_meta`, and
// `baseline_corpus_state` so the #524 measurement harness can run
// against a synthetic tenant without waiting 30 days of cadence accrual.
//
// Invocation
// ----------
//
//   pnpm node scripts/seed-baseline-corpus-for-measurement.mjs \
//     --connection-string=postgres://postgres:postgres@localhost:5434/customer_customer_a_8983d4 \
//     --seed=42 \
//     [--baseline-rows=200000] \
//     [--observed-rows=1000000] \
//     [--days=30] \
//     [--orig-addrs=500] \
//     [--anchor-time=2026-05-13T00:00:00Z] \
//     [--reset]
//
// `--connection-string` and `--seed` are mandatory. `--anchor-time`
// defaults to the script's wall-clock startup time (captured once) so
// casual operator use still works, but the "same `--seed` produces
// byte-identical INSERTs" contract is conditional on BOTH flags —
// `--seed` alone is insufficient because `event_time` and
// `baseline_corpus_state.last_ingested_at` derive from the anchor.
//
// Without `--reset`, the script aborts if either corpus table is
// non-empty (avoids accidental dirty-state seeding). With `--reset`,
// both tables AND `baseline_corpus_state` are truncated / cleared
// before seeding; the pre-truncation row counts are logged so the
// operator can recover if they intended to keep the data.
//
// `VACUUM ANALYZE` is invoked on both tables after the INSERT pass
// (outside any transaction — `VACUUM` cannot run inside `BEGIN`/
// `COMMIT`). Skipping `ANALYZE` would leave the planner using default
// statistics and invalidate the #524 measurement.
//
// Determinism notes
// -----------------
//
//   * PRNG is a `mulberry32` seeded once from `--seed`. `Math.random`
//     is forbidden anywhere in row generation.
//   * Every timestamp derives from the resolved `--anchor-time`
//     captured at startup. `Date.now()` / `new Date()` are NOT used
//     during row generation.
//   * Span sentinels: one row at `anchor − :days − 1s` and one at
//     `anchor − 1s` are forced into both tables so the #524 profile
//     assertion `historicalSpanMs >= :days` passes deterministically
//     at the lower-bound margin, and the freshness check
//     `MAX(event_time) within 2h of now()` passes whenever `anchor`
//     is within ~2h of wall-clock `now()`.

import pg from "pg";

const PHASE_1A_BASELINE_VERSION = "phase1a-simple";
const PHASE_1B_BASELINE_VERSION = "phase1b-four-selector";

// 10 kinds drawn from the catalog the cadence pager emits. Sum = 100.
// HttpThreat ≈ 30% so the unlabeled-cluster bucket has enough mass;
// `RepeatedHttpSessions` and `SuspiciousTlsTraffic` each retain enough
// share that the §4 slot allocator's favored-bucket β-bonus path is
// exercised; the remainder spreads Zipf-like over the other kinds.
// `Blocklist*` kinds are intentionally omitted — the cadence pager
// drops them before INSERT (`BLOCKLIST_KIND_PREFIX` in
// `src/lib/triage/baseline/pager.ts`), so production corpora never
// contain them.
const KIND_WEIGHTS = [
  { name: "HttpThreat", weight: 30, family: "http" },
  { name: "DnsCovertChannel", weight: 15, family: "dns" },
  { name: "LockyRansomware", weight: 10, family: "http" },
  { name: "LdapPlainText", weight: 10, family: "host" },
  { name: "FtpPlainText", weight: 8, family: "host" },
  { name: "DomainGenerationAlgorithm", weight: 8, family: "dns" },
  { name: "TorConnection", weight: 7, family: "host" },
  { name: "NonBrowser", weight: 5, family: "http" },
  { name: "RepeatedHttpSessions", weight: 4, family: "http" },
  { name: "SuspiciousTlsTraffic", weight: 3, family: "host" },
];

// SCREAMING_SNAKE_CASE per `CRITICAL_CATEGORIES` in
// `src/lib/triage/baseline/categories.ts`. The S2 selector compares
// against these literal values; any other casing breaks the match.
const CRITICAL_CATEGORIES = [
  "COMMAND_AND_CONTROL",
  "EXFILTRATION",
  "IMPACT",
  "INITIAL_ACCESS",
  "CREDENTIAL_ACCESS",
];

// Phase 1.B selector tag names from `SELECTOR_TAGS` in
// `src/lib/triage/baseline/tunables.ts`.
const BASE_SELECTOR_TAGS = [
  "S1-high",
  "S2-severe",
  "S3-recurring",
  "S4-correlated",
];
const UNLABELED_TAG = "unlabeled-cluster";

const SENSOR_COUNT = 8;
const CHUNK_SIZE = 1_000;
const DEFAULT_BASELINE_ROWS = 200_000;
const DEFAULT_OBSERVED_ROWS = 1_000_000;
const DEFAULT_DAYS = 30;
const DEFAULT_ORIG_ADDRS = 500;
const PHASE_1A_FRACTION = 0.05;
const CATEGORY_NULL_FRACTION = 0.2;
const HTTP_THREAT_UNLABELED_FRACTION = 0.6;
// Top-10 addresses account for ≈ 40% of rows — mirrors a real
// "few noisy assets" pattern. Long tail covers the remaining 60% over
// the other ≥ 490 addresses.
const HOT_ADDR_COUNT = 10;
const HOT_ADDR_FRACTION = 0.4;

/**
 * mulberry32 PRNG. Cheap, deterministic, and produces a well-distributed
 * sequence for the kind of long-tail draws this seed script makes.
 * Initialized once from `--seed` per invocation.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseArgs(argv) {
  const args = {
    connectionString: null,
    baselineRows: DEFAULT_BASELINE_ROWS,
    observedRows: DEFAULT_OBSERVED_ROWS,
    days: DEFAULT_DAYS,
    origAddrs: DEFAULT_ORIG_ADDRS,
    seed: null,
    anchorTime: null,
    reset: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--reset") {
      args.reset = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (!raw.startsWith("--") || eq === -1) {
      throw new Error(`unrecognized argument: ${raw}`);
    }
    const key = raw.slice(2, eq);
    const value = raw.slice(eq + 1);
    switch (key) {
      case "connection-string":
        args.connectionString = value;
        break;
      case "baseline-rows":
        args.baselineRows = Number.parseInt(value, 10);
        break;
      case "observed-rows":
        args.observedRows = Number.parseInt(value, 10);
        break;
      case "days":
        args.days = Number.parseInt(value, 10);
        break;
      case "orig-addrs":
        args.origAddrs = Number.parseInt(value, 10);
        break;
      case "seed":
        args.seed = Number.parseInt(value, 10);
        break;
      case "anchor-time":
        args.anchorTime = value;
        break;
      default:
        throw new Error(`unrecognized flag: --${key}`);
    }
  }
  if (!args.connectionString) {
    throw new Error("missing required flag: --connection-string=<dsn>");
  }
  if (!Number.isFinite(args.seed)) {
    throw new Error("missing required flag: --seed=<integer>");
  }
  if (!Number.isFinite(args.baselineRows) || args.baselineRows < 1) {
    throw new Error(`invalid --baseline-rows: ${args.baselineRows}`);
  }
  if (!Number.isFinite(args.observedRows) || args.observedRows < 1) {
    throw new Error(`invalid --observed-rows: ${args.observedRows}`);
  }
  if (args.observedRows < args.baselineRows) {
    throw new Error(
      `--observed-rows (${args.observedRows}) must be >= --baseline-rows (${args.baselineRows})`,
    );
  }
  if (!Number.isFinite(args.days) || args.days < 1) {
    throw new Error(`invalid --days: ${args.days}`);
  }
  if (!Number.isFinite(args.origAddrs) || args.origAddrs <= HOT_ADDR_COUNT) {
    throw new Error(
      `invalid --orig-addrs: ${args.origAddrs} (must be > ${HOT_ADDR_COUNT} so the cold tail has at least one address)`,
    );
  }
  return args;
}

/**
 * Resolve `--anchor-time` to milliseconds. When the flag is omitted the
 * caller supplies the current wall clock so casual operator use still
 * works; the resolved value is then captured once and threaded through
 * every subsequent time derivation so the run remains internally
 * consistent.
 */
export function resolveAnchorMs(anchorTime, nowMs) {
  if (anchorTime === null) return nowMs;
  const parsed = Date.parse(anchorTime);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `invalid --anchor-time: ${anchorTime} (expected ISO 8601, e.g. 2026-05-13T00:00:00Z)`,
    );
  }
  return parsed;
}

/**
 * Deterministic address pool. Mix of RFC1918 (`10.*`, `192.168.*`,
 * `172.16.*`) and external IPv4. The first {@link HOT_ADDR_COUNT}
 * entries are the "hot" addresses that carry {@link HOT_ADDR_FRACTION}
 * of the per-row draws.
 */
export function buildAddressPool(count) {
  const pool = [];
  const seen = new Set();
  let i = 0;
  while (pool.length < count) {
    const bucket = i % 4;
    const j = Math.floor(i / 4);
    let addr;
    if (bucket === 0) {
      addr = `10.${j % 256}.${(j * 7) % 256}.${((j * 13) % 254) + 1}`;
    } else if (bucket === 1) {
      addr = `192.168.${j % 256}.${((j * 11) % 254) + 1}`;
    } else if (bucket === 2) {
      // 172.16.0.0/12 → second octet ∈ [16, 31].
      addr = `172.${16 + (j % 16)}.${(j * 5) % 256}.${((j * 17) % 254) + 1}`;
    } else {
      const a = 50 + (j % 150);
      addr = `${a}.${(j * 7) % 256}.${(j * 13) % 256}.${((j * 19) % 254) + 1}`;
    }
    if (!seen.has(addr)) {
      seen.add(addr);
      pool.push(addr);
    }
    i += 1;
  }
  return pool;
}

/**
 * Cumulative weight array for picking from the address pool. Top
 * {@link HOT_ADDR_COUNT} entries collectively receive
 * {@link HOT_ADDR_FRACTION} of the draws; the remainder share the rest.
 */
export function buildAddressCumulative(count) {
  const hot = HOT_ADDR_COUNT;
  const cold = count - hot;
  const hotWeight = HOT_ADDR_FRACTION / hot;
  const coldWeight = (1 - HOT_ADDR_FRACTION) / cold;
  const cum = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    acc += i < hot ? hotWeight : coldWeight;
    cum[i] = acc;
  }
  cum[count - 1] = 1; // guard against fp drift on the last bucket
  return cum;
}

export function buildKindCumulative() {
  const total = KIND_WEIGHTS.reduce((s, k) => s + k.weight, 0);
  const cum = new Float64Array(KIND_WEIGHTS.length);
  let acc = 0;
  for (let i = 0; i < KIND_WEIGHTS.length; i += 1) {
    acc += KIND_WEIGHTS[i].weight / total;
    cum[i] = acc;
  }
  cum[cum.length - 1] = 1;
  return cum;
}

export function pickIndexFromU(u, cumulative) {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function familyToFields(family, eventKey) {
  switch (family) {
    case "http":
      return {
        host: `host-${eventKey % 4096}.example.com`,
        dnsQuery: null,
        uri: `/path/${eventKey % 1024}`,
      };
    case "dns":
      return {
        host: null,
        dnsQuery: `q${eventKey % 4096}.example.com`,
        uri: null,
      };
    case "host":
      return {
        host: `host-${eventKey % 4096}.example.com`,
        dnsQuery: null,
        uri: null,
      };
    default:
      return { host: null, dnsQuery: null, uri: null };
  }
}

function respPortForKind(family) {
  if (family === "dns") return 53;
  if (family === "host") return 443;
  return 80;
}

/**
 * Build the 1..4 base tags + optional `unlabeled-cluster` for one row.
 * Phase 1.A rows predate the tag emission and MUST NOT carry
 * `unlabeled-cluster`; their tags are a small subset of the four base
 * tags (RFC 0001 §9). Phase 1.B `HttpThreat` rows receive
 * `unlabeled-cluster` on ≈ 60% of rows — drives the unlabeled-bucket
 * carve-out in `composeMenu`.
 */
export function buildSelectorTags(
  uCount,
  uOffset,
  uUnlabeled,
  baselineVersion,
  kindName,
) {
  const count = 1 + Math.floor(uCount * BASE_SELECTOR_TAGS.length);
  const offset = Math.floor(uOffset * BASE_SELECTOR_TAGS.length);
  const tags = [];
  for (let i = 0; i < count; i += 1) {
    tags.push(BASE_SELECTOR_TAGS[(offset + i) % BASE_SELECTOR_TAGS.length]);
  }
  if (
    baselineVersion === PHASE_1B_BASELINE_VERSION &&
    kindName === "HttpThreat" &&
    uUnlabeled < HTTP_THREAT_UNLABELED_FRACTION
  ) {
    tags.push(UNLABELED_TAG);
  }
  return tags;
}

function buildRawScore(u1, u2) {
  // Long-tail in [0, 1] — `min(u1, u2)` is beta(1, 2)-shaped, so most
  // rows land in the lower-middle and a thinner tail extends into the
  // higher range. The exact distribution is not load-bearing for the
  // measurement; the seed only needs the per-partition `cume_dist()`
  // to be non-trivially distributed.
  const v = u1 < u2 ? u1 : u2;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function buildCategory(uNull, uPick) {
  if (uNull < CATEGORY_NULL_FRACTION) return null;
  const idx = Math.min(
    Math.floor(uPick * CRITICAL_CATEGORIES.length),
    CRITICAL_CATEGORIES.length - 1,
  );
  return CRITICAL_CATEGORIES[idx];
}

async function flushObserved(client, rows) {
  if (rows.length === 0) return;
  const params = [];
  const placeholders = [];
  for (const r of rows) {
    const base = params.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
    );
    params.push(
      r.eventKey,
      r.eventTimeIso,
      r.kind,
      r.category,
      r.sensor,
      r.origAddr,
      r.respAddr,
      r.host,
      r.dnsQuery,
      r.uri,
      r.confidence,
    );
  }
  await client.query(
    `INSERT INTO observed_event_meta (
        event_key, event_time, kind, category, sensor,
        orig_addr, resp_addr, host, dns_query, uri, confidence
      ) VALUES ${placeholders.join(", ")}`,
    params,
  );
}

async function flushBaseline(client, rows) {
  if (rows.length === 0) return;
  const params = [];
  const placeholders = [];
  for (const r of rows) {
    const base = params.length;
    const ph = [];
    for (let j = 1; j <= 20; j += 1) ph.push(`$${base + j}`);
    placeholders.push(`(${ph.join(", ")})`);
    params.push(
      r.eventKey,
      r.eventTimeIso,
      r.kind,
      r.sensor,
      r.origAddr,
      r.origPort,
      r.respAddr,
      r.respPort,
      r.proto,
      r.host,
      r.dnsQuery,
      r.uri,
      r.ingestedAtIso,
      r.baselineVersion,
      r.exclusionsFp,
      r.category,
      r.baselineScore,
      r.rawScore,
      r.selectorTags,
      r.payloadSummary,
    );
  }
  await client.query(
    `INSERT INTO baseline_triaged_event (
        event_key, event_time, kind, sensor,
        orig_addr, orig_port, resp_addr, resp_port, proto,
        host, dns_query, uri,
        ingested_at, baseline_version, exclusions_fp, category,
        baseline_score, raw_score, selector_tags, payload_summary
      ) VALUES ${placeholders.join(", ")}`,
    params,
  );
}

/**
 * Stream observed + baseline rows through chunked INSERTs. The two
 * tables share a deterministic event-key space — every baseline
 * `event_key` is also present in `observed_event_meta` — by walking a
 * single index `i ∈ [0, observedRows)` and tagging every `step`-th row
 * as also-baseline. Common fields are drawn from the PRNG for every
 * row; baseline-specific fields are drawn only for the subset, so the
 * per-row PRNG consumption pattern is `commonDraws (+ baselineDraws if
 * baseline)`. This pattern is documented for the determinism test —
 * changing the draw count or order is a byte-identical-output break.
 */
export async function seedCorpus({
  client,
  observedRows,
  baselineRows,
  days,
  origAddrs,
  seed,
  anchorMs,
  exclusionsFp,
  log,
}) {
  const daysMs = days * 24 * 60 * 60 * 1000;
  const step = Math.floor(observedRows / baselineRows);
  const prng = mulberry32(seed);
  const kindCum = buildKindCumulative();
  const addrPool = buildAddressPool(origAddrs);
  const addrCum = buildAddressCumulative(origAddrs);
  // `ingested_at` is anchor-derived (NOT `now()` from the schema default)
  // so identical `--seed` + `--anchor-time` invocations produce byte-
  // identical row state, satisfying the issue's idempotency contract.
  // Aligning with `baseline_corpus_state.last_ingested_at = anchor − 1h`
  // keeps both clocks consistent.
  const ingestedAtIso = new Date(anchorMs - 60 * 60 * 1000).toISOString();

  // Sentinels go on the first two baseline-subset rows — they MUST be
  // in both tables so `MAX(event_time) − MIN(event_time) = days`
  // holds on both the harness's profile probes.
  //
  // Non-sentinel rows draw `event_time` over `[anchor − :days,
  // anchor − 2s)` (a strict subset of `[anchor − :days, anchor)`) so
  // no natural draw can land between the upper sentinel and `anchor`
  // and unseat `MAX(event_time) = anchor − 1s`. The 2-second cushion
  // on the upper bound, combined with the 1-second cushion on the
  // sentinel, keeps the sentinels strictly outside the natural-draw
  // range on both ends.
  const sentinelMinIdx = 0;
  const sentinelMaxIdx = step;
  const sentinelMinMs = anchorMs - daysMs - 1000;
  const sentinelMaxMs = anchorMs - 1000;
  const naturalUpperOffsetMs = 2000;
  const naturalRangeMs = daysMs - naturalUpperOffsetMs;

  let observedBuffer = [];
  let baselineBuffer = [];
  let observedInserted = 0;
  let baselineInserted = 0;
  const startMs = Date.now();

  for (let i = 0; i < observedRows; i += 1) {
    // Common stream — fixed order, drawn for every row.
    const uTime = prng();
    const uKind = prng();
    const uOrig = prng();
    const uResp = prng();
    const uPort = prng();
    const uCatNull = prng();
    const uCatPick = prng();
    const uConfidence = prng();

    let eventTimeMs;
    if (i === sentinelMinIdx) eventTimeMs = sentinelMinMs;
    else if (i === sentinelMaxIdx) eventTimeMs = sentinelMaxMs;
    else
      eventTimeMs =
        anchorMs - naturalUpperOffsetMs - Math.floor(uTime * naturalRangeMs);

    const eventKeyNum = i + 1;
    const eventKey = eventKeyNum.toString();
    const eventTimeIso = new Date(eventTimeMs).toISOString();
    const kindMeta = KIND_WEIGHTS[pickIndexFromU(uKind, kindCum)];
    const sensor = `sensor-${i % SENSOR_COUNT}`;
    const origAddr = addrPool[pickIndexFromU(uOrig, addrCum)];
    const respAddr = addrPool[pickIndexFromU(uResp, addrCum)];
    const origPort = 1024 + Math.floor(uPort * 60_000);
    const respPort = respPortForKind(kindMeta.family);
    const fields = familyToFields(kindMeta.family, eventKeyNum);
    const category = buildCategory(uCatNull, uCatPick);
    const confidence = Number(uConfidence.toFixed(4));

    observedBuffer.push({
      eventKey,
      eventTimeIso,
      kind: kindMeta.name,
      category,
      sensor,
      origAddr,
      respAddr,
      host: fields.host,
      dnsQuery: fields.dnsQuery,
      uri: fields.uri,
      confidence,
    });

    const isBaseline = i % step === 0 && i / step < baselineRows;
    if (isBaseline) {
      // Baseline-only stream — drawn ONLY for subset rows so the
      // per-row PRNG consumption pattern stays deterministic across
      // different `--baseline-rows` / `--observed-rows` ratios.
      const uVersion = prng();
      const uScore1 = prng();
      const uScore2 = prng();
      const uTagCount = prng();
      const uTagOffset = prng();
      const uUnlabeled = prng();

      const baselineVersion =
        uVersion < PHASE_1A_FRACTION
          ? PHASE_1A_BASELINE_VERSION
          : PHASE_1B_BASELINE_VERSION;
      const rawScore = buildRawScore(uScore1, uScore2);
      const selectorTags = buildSelectorTags(
        uTagCount,
        uTagOffset,
        uUnlabeled,
        baselineVersion,
        kindMeta.name,
      );

      baselineBuffer.push({
        eventKey,
        eventTimeIso,
        kind: kindMeta.name,
        sensor,
        origAddr,
        origPort,
        respAddr,
        respPort,
        proto: null,
        host: fields.host,
        dnsQuery: fields.dnsQuery,
        uri: fields.uri,
        ingestedAtIso,
        baselineVersion,
        exclusionsFp,
        category,
        baselineScore: null,
        rawScore,
        selectorTags,
        payloadSummary: null,
      });
    }

    if (observedBuffer.length >= CHUNK_SIZE) {
      await flushObserved(client, observedBuffer);
      observedInserted += observedBuffer.length;
      observedBuffer = [];
    }
    if (baselineBuffer.length >= CHUNK_SIZE) {
      await flushBaseline(client, baselineBuffer);
      baselineInserted += baselineBuffer.length;
      baselineBuffer = [];
    }
  }

  if (observedBuffer.length > 0) {
    await flushObserved(client, observedBuffer);
    observedInserted += observedBuffer.length;
  }
  if (baselineBuffer.length > 0) {
    await flushBaseline(client, baselineBuffer);
    baselineInserted += baselineBuffer.length;
  }

  const elapsedMs = Date.now() - startMs;
  if (log) {
    log(
      `[seed] inserted ${observedInserted.toLocaleString()} observed_event_meta + ${baselineInserted.toLocaleString()} baseline_triaged_event rows in ${(elapsedMs / 1000).toFixed(1)}s`,
    );
  }
  return { observedInserted, baselineInserted, elapsedMs };
}

export async function preflightOrReset(client, reset, log) {
  const baselineCount = await scalarCount(
    client,
    "SELECT COUNT(*)::text AS count FROM baseline_triaged_event",
  );
  const observedCount = await scalarCount(
    client,
    "SELECT COUNT(*)::text AS count FROM observed_event_meta",
  );
  if (reset) {
    if (log) {
      log(
        `[seed] --reset: truncating baseline_triaged_event (${baselineCount.toLocaleString()} rows) and observed_event_meta (${observedCount.toLocaleString()} rows); resetting baseline_corpus_state`,
      );
    }
    await client.query("TRUNCATE baseline_triaged_event");
    await client.query("TRUNCATE observed_event_meta");
    await client.query("DELETE FROM baseline_corpus_state");
    return;
  }
  if (baselineCount > 0 || observedCount > 0) {
    throw new Error(
      `corpus tables non-empty (baseline_triaged_event=${baselineCount}, observed_event_meta=${observedCount}); ` +
        "re-run with --reset to truncate and re-seed, or seed against a fresh tenant DB",
    );
  }
}

async function scalarCount(client, sql) {
  const { rows } = await client.query(sql);
  if (rows.length === 0) return 0;
  return Number(rows[0].count);
}

export async function updateCorpusState({
  client,
  anchorMs,
  days,
  exclusionsFp,
}) {
  const daysMs = days * 24 * 60 * 60 * 1000;
  // `last_ingested_at = anchor − 1h` so the harness's freshness
  // predicate (`last_ingested_at < 2h ago` measured against wall-clock
  // `now()`) passes whenever the operator's anchor is within ~1h of
  // the run. `corpus_activated_at = anchor − :days` so every §7 window
  // (7d / 14d / 30d) is active under the cold-start activation logic.
  const lastIngestedAtIso = new Date(anchorMs - 60 * 60 * 1000).toISOString();
  const corpusActivatedAtIso = new Date(anchorMs - daysMs).toISOString();
  await client.query(
    `INSERT INTO baseline_corpus_state (
        id, last_ingested_at, last_event_cursor, baseline_version,
        exclusions_fp, last_run_status, last_error, corpus_activated_at
      ) VALUES (true, $1, $2, $3, $4, 'ok', NULL, $5)
      ON CONFLICT (id) DO UPDATE SET
        last_ingested_at    = EXCLUDED.last_ingested_at,
        last_event_cursor   = EXCLUDED.last_event_cursor,
        baseline_version    = EXCLUDED.baseline_version,
        exclusions_fp       = EXCLUDED.exclusions_fp,
        last_run_status     = EXCLUDED.last_run_status,
        last_error          = NULL,
        corpus_activated_at = EXCLUDED.corpus_activated_at`,
    [
      lastIngestedAtIso,
      "seed-synthetic-cursor",
      PHASE_1B_BASELINE_VERSION,
      exclusionsFp,
      corpusActivatedAtIso,
    ],
  );
}

/**
 * `VACUUM ANALYZE` both corpus tables. Issued outside any explicit
 * transaction — `VACUUM` raises `VACUUM cannot run inside a transaction
 * block` otherwise. Logs row counts and elapsed time so the operator
 * sees the pass actually ran.
 */
export async function vacuumAnalyzeCorpus(pool, log) {
  for (const table of ["baseline_triaged_event", "observed_event_meta"]) {
    const startMs = Date.now();
    await pool.query(`VACUUM ANALYZE ${table}`);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::text AS count FROM ${table}`,
    );
    const count = Number(rows[0].count);
    if (log) {
      log(
        `[seed] VACUUM ANALYZE ${table}: ${count.toLocaleString()} rows in ${(
          (Date.now() - startMs) / 1000
        ).toFixed(1)}s`,
      );
    }
  }
}

export function redactDsn(dsn) {
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable-dsn>";
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const anchorMs = resolveAnchorMs(args.anchorTime, Date.now());
  const anchorIso = new Date(anchorMs).toISOString();
  const exclusionsFp = `seed-synthetic-${args.seed}`;

  process.stdout.write(
    `[seed] connection=${redactDsn(args.connectionString)} seed=${args.seed} ` +
      `anchor=${anchorIso} baseline=${args.baselineRows.toLocaleString()} ` +
      `observed=${args.observedRows.toLocaleString()} days=${args.days} ` +
      `orig_addrs=${args.origAddrs} reset=${args.reset}\n`,
  );

  const pool = new pg.Pool({ connectionString: args.connectionString });
  try {
    const client = await pool.connect();
    try {
      await preflightOrReset(client, args.reset, (m) =>
        process.stdout.write(`${m}\n`),
      );
      await seedCorpus({
        client,
        observedRows: args.observedRows,
        baselineRows: args.baselineRows,
        days: args.days,
        origAddrs: args.origAddrs,
        seed: args.seed,
        anchorMs,
        exclusionsFp,
        log: (m) => process.stdout.write(`${m}\n`),
      });
      await updateCorpusState({
        client,
        anchorMs,
        days: args.days,
        exclusionsFp,
      });
    } finally {
      client.release();
    }
    // VACUUM cannot run inside a transaction block, and the pg pool's
    // implicit autocommit only applies to top-level queries on a
    // connection that is NOT currently in BEGIN/COMMIT. We run
    // `vacuumAnalyzeCorpus` on the pool (a new short-lived connection)
    // AFTER the INSERT client released, so there is no outer
    // transaction to fight with.
    await vacuumAnalyzeCorpus(pool, (m) => process.stdout.write(`${m}\n`));
  } finally {
    await pool.end();
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
