/**
 * Per-subtype "protocol highlights" for the Quick peek inspector
 * (Phase Detection-18).
 *
 * Each subtype lists a handful of fields the peek surfaces at a
 * glance, alongside a label key under the shared
 * `detection.quickPeek.protocol.fields` translation namespace. The
 * list stays deliberately short — per the issue, "under ~10 fields;
 * the rest belongs to the Investigation view." Empty values are
 * hidden at render time (see `pickHighlightValues`) rather than
 * rendered as `(Not Provided)` placeholders, so a subtype whose
 * fields happen to all be empty simply omits the Protocol section.
 *
 * The fields here must also be present in the inline fragments of
 * `EVENT_LIST_QUERY` for the subtype — the list query is the source
 * of the Quick peek payload, and any field not selected there will
 * be `undefined` at render time. Keep this table and the list query
 * in sync when the acceptance envelope grows.
 */
import type { Event } from "./types";

/** A single protocol-highlight entry for a subtype. */
export interface HighlightField {
  /** Key under `detection.quickPeek.protocol.fields` for the label. */
  labelKey: string;
  /** Accessor function that reads the field off the event node. */
  read: (event: Event) => HighlightValue;
  /**
   * When true the renderer surfaces a Copy-to-clipboard affordance
   * next to the value. The issue requires Copy on key data values
   * (IP, hostname, userId); fields that carry a hostname or a user
   * identifier should opt in here so the operator can pull the value
   * into another tool without text selection.
   */
  copyable?: boolean;
}

/**
 * A rendered highlight value — either a simple scalar (string /
 * number / boolean — printable as text) or a short array surfaced as
 * a list of badges / tokens. The renderer hides empty / null values.
 */
export type HighlightValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | null
  | undefined;

/**
 * Read an arbitrary field off an event with no type narrowing — the
 * curated `Event` union only commits to the interface's common
 * fields, so kind-specific reads fall through `unknown`. Callers
 * clamp the return value back to `HighlightValue` before rendering.
 */
function field(name: string): (event: Event) => HighlightValue {
  return (event) => {
    const v = (event as unknown as Record<string, unknown>)[name];
    if (v === null || v === undefined) return null;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      return v;
    }
    if (Array.isArray(v)) {
      // Only homogeneous string / number arrays are rendered as
      // badge lists; mixed arrays and nested objects fall through
      // as null so the renderer does not stringify `[object Object]`.
      if (v.every((x) => typeof x === "string")) return v as readonly string[];
      if (v.every((x) => typeof x === "number")) return v as readonly number[];
    }
    return null;
  };
}

/**
 * Per-typename protocol highlight tables. Subtypes not listed here
 * render no Protocol section (the other sections — Summary /
 * Endpoints / Detection meta — still render). Keep each list short
 * so the peek stays compact at narrow widths.
 */
export const QUICK_PEEK_HIGHLIGHTS: Record<string, HighlightField[]> = {
  BlocklistDns: [
    { labelKey: "dnsQuery", read: field("query"), copyable: true },
    { labelKey: "dnsQueryType", read: field("qtype") },
    { labelKey: "dnsResponseCode", read: field("rcode") },
  ],
  BlocklistHttp: [
    { labelKey: "httpMethod", read: field("method") },
    { labelKey: "httpHost", read: field("host"), copyable: true },
    { labelKey: "httpUri", read: field("uri"), copyable: true },
    { labelKey: "httpStatusCode", read: field("statusCode") },
  ],
  BlocklistTls: [
    { labelKey: "tlsServerName", read: field("serverName"), copyable: true },
    { labelKey: "tlsVersion", read: field("version") },
    { labelKey: "tlsJa3", read: field("ja3"), copyable: true },
  ],
  DnsCovertChannel: [
    { labelKey: "dnsQuery", read: field("query"), copyable: true },
    { labelKey: "dnsQueryType", read: field("qtype") },
    { labelKey: "dnsResponseCode", read: field("rcode") },
  ],
  ExternalDdos: [
    { labelKey: "startTime", read: field("startTime") },
    { labelKey: "endTime", read: field("endTime") },
  ],
  FtpBruteForce: [
    { labelKey: "userList", read: field("userList"), copyable: true },
    { labelKey: "startTime", read: field("startTime") },
    { labelKey: "endTime", read: field("endTime") },
    { labelKey: "isInternal", read: field("isInternal") },
  ],
  HttpThreat: [
    { labelKey: "httpMethod", read: field("method") },
    { labelKey: "httpHost", read: field("host"), copyable: true },
    { labelKey: "httpUri", read: field("uri"), copyable: true },
    { labelKey: "httpStatusCode", read: field("statusCode") },
  ],
  MultiHostPortScan: [
    { labelKey: "startTime", read: field("startTime") },
    { labelKey: "endTime", read: field("endTime") },
  ],
  NetworkThreat: [{ labelKey: "networkService", read: field("service") }],
  PortScan: [
    { labelKey: "startTime", read: field("startTime") },
    { labelKey: "endTime", read: field("endTime") },
  ],
  RdpBruteForce: [
    { labelKey: "startTime", read: field("startTime") },
    { labelKey: "endTime", read: field("endTime") },
  ],
  SuspiciousTlsTraffic: [
    { labelKey: "tlsServerName", read: field("serverName"), copyable: true },
    { labelKey: "tlsVersion", read: field("version") },
    { labelKey: "tlsJa3", read: field("ja3"), copyable: true },
  ],
};

/** Rendered highlight ready for display. Empty-valued fields are filtered out. */
export interface RenderedHighlight {
  labelKey: string;
  value: HighlightValue;
  /** Mirrored from {@link HighlightField.copyable} so the renderer can decide where to put the Copy affordance. */
  copyable: boolean;
}

/**
 * Produce the subset of {@link QUICK_PEEK_HIGHLIGHTS} entries whose
 * accessor returns a non-empty value for the given event. Used by
 * the Quick peek renderer so a subtype whose schema only ever
 * populates some of its highlight fields still renders a tidy
 * Protocol section without empty rows. Returns an empty array when
 * the subtype has no highlights at all.
 */
export function pickHighlightValues(event: Event): RenderedHighlight[] {
  const entries = QUICK_PEEK_HIGHLIGHTS[event.__typename];
  if (!entries) return [];
  const out: RenderedHighlight[] = [];
  for (const entry of entries) {
    const value = entry.read(event);
    if (!isEmpty(value)) {
      out.push({
        labelKey: entry.labelKey,
        value,
        copyable: entry.copyable === true,
      });
    }
  }
  return out;
}

function isEmpty(value: HighlightValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
