/**
 * Pivot-dimension registry for the Triage menu (Phase 1.A — Tier 1).
 *
 * Each dimension declares how to extract its values from a single
 * scored event. The pivot index in `./index.ts` walks every event
 * through every dimension once to build a `Map<value, events[]>`
 * grouping; the Related-events panel reads from that grouping.
 *
 * Per #447 §6 (deprecatable seam) this module — and everything else
 * under `src/lib/triage/pivot/` — must not import from the policy
 * subtree. Tier 2 weak-signal rendering and the mode toggle wiring
 * are #453's scope, not this issue's.
 */

import { classifyTriageEndpoint } from "../classify";
import type { ScoredTriageEvent } from "../types";
import {
  extractRegistrableDomain,
  normalizeUriPattern,
  timeBucketKey,
} from "./normalize";

/**
 * Stable identifier set for the Phase 1.A pivot dimensions. Strings,
 * not enums, so the panel can render i18n labels keyed by id without
 * threading the enum through every prop.
 */
export type PivotDimensionId =
  | "externalIp"
  | "internalIp"
  | "port"
  | "country"
  | "registrableDomain"
  | "host"
  | "uriPattern"
  | "userAgent"
  | "ja3"
  | "ja3s"
  | "sni"
  | "certSerial"
  | "certSubjectCn"
  | "dnsQuery"
  | "dnsAnswer"
  | "sameKindWithin15Min"
  | "sameSensor"
  | "clusterId";

/**
 * Pivot value. Carries both the canonical pivot key (the index key
 * the panel groups events by) and a human-readable label the panel
 * shows to the operator. Two values are equal iff their `key` is
 * equal — `label` is presentational only.
 */
export interface PivotValue {
  key: string;
  label: string;
}

/**
 * One pivot dimension. The extractor returns the values present on
 * this event; an event can carry multiple values for one dimension
 * (e.g. an event with both an external `origAddr` and an external
 * `respAddr` produces two `externalIp` values).
 */
export interface PivotDimension {
  id: PivotDimensionId;
  /**
   * `network`, `application`, `tls`, `dns`, `time-structure`. Used by
   * the panel only for grouping section headers; not part of the
   * pivot key.
   */
  family: PivotDimensionFamily;
  extract(event: ScoredTriageEvent): PivotValue[];
}

export type PivotDimensionFamily =
  | "network"
  | "application"
  | "tls"
  | "dns"
  | "time-structure";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ipDimension(id: "externalIp" | "internalIp"): PivotDimension {
  const wantInternal = id === "internalIp";
  return {
    id,
    family: "network",
    extract(event) {
      const out: PivotValue[] = [];
      const seen = new Set<string>();
      for (const side of ["orig", "resp"] as const) {
        const addr =
          side === "orig" ? (event.origAddr ?? null) : (event.respAddr ?? null);
        if (typeof addr !== "string" || addr.length === 0) continue;
        const klass = classifyTriageEndpoint(event, side);
        if (klass === "unknown") continue;
        const isInternal = klass === "internal";
        if (isInternal !== wantInternal) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);
        out.push({ key: addr, label: addr });
      }
      return out;
    },
  };
}

const PORT_DIMENSION: PivotDimension = {
  id: "port",
  family: "network",
  extract(event) {
    // Index on `respPort` (destination port) — that is the
    // operator-meaningful pivot for "what service is the asset
    // talking to". `origPort` is ephemeral and mostly random.
    const respPort = event.respPort;
    if (typeof respPort !== "number" || !Number.isFinite(respPort)) return [];
    const key = String(respPort);
    return [{ key, label: key }];
  },
};

const COUNTRY_DIMENSION: PivotDimension = {
  id: "country",
  family: "network",
  extract(event) {
    const out: PivotValue[] = [];
    const seen = new Set<string>();
    for (const cc of [event.origCountry, event.respCountry]) {
      const value = nonEmptyString(cc);
      if (!value) continue;
      const upper = value.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      out.push({ key: upper, label: upper });
    }
    return out;
  },
};

const REGISTRABLE_DOMAIN_DIMENSION: PivotDimension = {
  id: "registrableDomain",
  family: "application",
  extract(event) {
    const out: PivotValue[] = [];
    const seen = new Set<string>();
    for (const candidate of [event.host, event.serverName, event.query]) {
      const domain = extractRegistrableDomain(candidate);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ key: domain, label: domain });
    }
    return out;
  },
};

const HOST_DIMENSION: PivotDimension = {
  id: "host",
  family: "application",
  extract(event) {
    const value = nonEmptyString(event.host);
    if (!value) return [];
    const lower = value.toLowerCase();
    return [{ key: lower, label: lower }];
  },
};

const URI_PATTERN_DIMENSION: PivotDimension = {
  id: "uriPattern",
  family: "application",
  extract(event) {
    const pattern = normalizeUriPattern(event.uri);
    if (!pattern) return [];
    return [{ key: pattern, label: pattern }];
  },
};

const USER_AGENT_DIMENSION: PivotDimension = {
  id: "userAgent",
  family: "application",
  extract(event) {
    const value = nonEmptyString(event.userAgent);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

function tlsField(
  id: "ja3" | "ja3s" | "sni" | "certSerial" | "certSubjectCn",
  pick: (event: ScoredTriageEvent) => string | null | undefined,
): PivotDimension {
  return {
    id,
    family: "tls",
    extract(event) {
      const value = nonEmptyString(pick(event));
      if (!value) return [];
      return [{ key: value, label: value }];
    },
  };
}

const JA3_DIMENSION = tlsField("ja3", (e) => e.ja3);
const JA3S_DIMENSION = tlsField("ja3s", (e) => e.ja3S);
const SNI_DIMENSION = tlsField("sni", (e) => e.serverName);
const CERT_SERIAL_DIMENSION = tlsField("certSerial", (e) => e.serial);
const CERT_SUBJECT_CN_DIMENSION = tlsField(
  "certSubjectCn",
  (e) => e.subjectCommonName,
);

const DNS_QUERY_DIMENSION: PivotDimension = {
  id: "dnsQuery",
  family: "dns",
  extract(event) {
    const value = nonEmptyString(event.query);
    if (!value) return [];
    const lower = value.toLowerCase();
    return [{ key: lower, label: lower }];
  },
};

const DNS_ANSWER_DIMENSION: PivotDimension = {
  id: "dnsAnswer",
  family: "dns",
  extract(event) {
    const value = nonEmptyString(event.answer);
    if (!value) return [];
    // `answer` may carry comma- or space-separated multiple addresses
    // (REview emits a flat string per row). Split on whitespace and
    // commas, drop empties, dedupe.
    const tokens = value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const seen = new Set<string>();
    const out: PivotValue[] = [];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ key: token, label: token });
    }
    return out;
  },
};

const SAME_KIND_WITHIN_15_MIN_DIMENSION: PivotDimension = {
  id: "sameKindWithin15Min",
  family: "time-structure",
  extract(event) {
    const bucket = timeBucketKey(event.time);
    if (bucket === null) return [];
    const key = `${event.__typename}@${bucket}`;
    // Label uses the bucket's start time so the breadcrumb crumb is
    // operator-meaningful — `HttpThreat near 2026-05-09 12:30Z` reads
    // better than `HttpThreat@1746838170`.
    const startMs = bucket * (30 * 60 * 1000);
    const startIso = new Date(startMs).toISOString();
    const label = `${event.__typename} near ${startIso}`;
    return [{ key, label }];
  },
};

const SAME_SENSOR_DIMENSION: PivotDimension = {
  id: "sameSensor",
  family: "time-structure",
  extract(event) {
    const value = nonEmptyString(event.sensor);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

const CLUSTER_ID_DIMENSION: PivotDimension = {
  id: "clusterId",
  family: "time-structure",
  extract(event) {
    const value = nonEmptyString(event.clusterId);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

/**
 * Ordered list of every Phase 1.A pivot dimension. The panel renders
 * dimensions in this order — most-specific (operator-relevant)
 * dimensions first, structural ones last.
 */
export const PIVOT_DIMENSIONS: readonly PivotDimension[] = [
  ipDimension("externalIp"),
  ipDimension("internalIp"),
  PORT_DIMENSION,
  COUNTRY_DIMENSION,
  REGISTRABLE_DOMAIN_DIMENSION,
  HOST_DIMENSION,
  URI_PATTERN_DIMENSION,
  USER_AGENT_DIMENSION,
  JA3_DIMENSION,
  JA3S_DIMENSION,
  SNI_DIMENSION,
  CERT_SERIAL_DIMENSION,
  CERT_SUBJECT_CN_DIMENSION,
  DNS_QUERY_DIMENSION,
  DNS_ANSWER_DIMENSION,
  SAME_KIND_WITHIN_15_MIN_DIMENSION,
  SAME_SENSOR_DIMENSION,
  CLUSTER_ID_DIMENSION,
];

const DIMENSION_BY_ID = new Map<PivotDimensionId, PivotDimension>(
  PIVOT_DIMENSIONS.map((d) => [d.id, d]),
);

export function getPivotDimension(id: PivotDimensionId): PivotDimension {
  const dim = DIMENSION_BY_ID.get(id);
  if (!dim) throw new Error(`Unknown pivot dimension: ${id}`);
  return dim;
}
