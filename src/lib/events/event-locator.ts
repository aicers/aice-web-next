/**
 * Menu-neutral event locator.
 *
 * REview's `Event` interface does not expose a unique `id` field, so
 * v1 encodes the event's composite tuple into a URL-safe token. The
 * token is a **best-effort** locator — REview does not guarantee
 * uniqueness on this tuple — but in practice nanosecond-precision
 * timestamps make collisions extremely rare.
 *
 * This module lives under `src/lib/events/` rather than
 * `src/lib/detection/` because sibling menus (Triage, etc.) are
 * expected to reuse the same encoder/decoder. Keeping it
 * menu-neutral avoids import cycles when those menus arrive.
 *
 * Token format: `base64url(JSON(payload))`. Decoding is strict on
 * both shape and semantics — types are checked, timestamps must
 * parse, IP literals must be syntactically plausible, ports must
 * fit their ranges, and `kind` must be one of the curated
 * `CURATED_EVENT_TYPENAMES`. An invalid or tampered token produces
 * a `null` so callers render a documented "Invalid event link"
 * state rather than forwarding tampered values to REview.
 *
 * Fields that narrow the `eventList` filter in v1:
 *   - `time` → `start` and `end` (exact match)
 *   - `origAddr` → `source`
 *   - `respAddr` → `destination`
 *   - `kind` → `kinds[0]`
 *   - `level` → `levels[0]`
 *
 * Fields carried in the token for display / forward-compat only
 * (not used to narrow the query in v1):
 *   - `origPort`, `respPort`, `proto` — `EventListFilterInput` has
 *     no matching filter fields yet.
 *   - `sensor` — name is held; resolution to a sensor ID is the
 *     responsibility of #301 (soft dependency). When that query
 *     is available, the server action looks up the ID and adds
 *     `sensors: [<id>]` to the filter.
 */

import {
  CURATED_EVENT_TYPENAMES,
  type Event,
  type EventBase,
  type ThreatLevel,
} from "@/lib/detection/types";

/**
 * Minimum event shape required to build a locator. The curated
 * `Event` union exposes these fields on every subtype that carries
 * addressing information; subtypes without `origAddr` / `respAddr`
 * (e.g. pure metadata events) can't be linked to a full-page view
 * and should not be encoded.
 *
 * `MultiHostPortScan` exposes `respAddrs` (plural) rather than a
 * singular responder, and `ExternalDdos` exposes `origAddrs`
 * (plural) rather than a singular originator. Encoders pass the
 * plural field and the first entry is picked as the locator's
 * singular counterpart, keeping the token shape stable while
 * letting Quick peek produce a link for those subtypes. Honest
 * best-effort semantics — the page resolves one source/target and
 * the Endpoints tab renders the remaining originators/destinations
 * once the event payload is fetched.
 */
export interface EventLocatorSource {
  __typename: string;
  time: string;
  sensor: string;
  level: ThreatLevel;
  origAddr?: string | null;
  origAddrs?: readonly string[] | null;
  respAddr?: string | null;
  respAddrs?: readonly string[] | null;
  origPort?: number | null;
  respPort?: number | null;
  proto?: number | null;
}

/**
 * Decoded token payload. All fields are present because the
 * encoder rejects events missing addressing data — a decoded
 * payload therefore carries enough information to build the
 * tight filter below.
 */
export interface EventLocator {
  sensor: string;
  time: string;
  origAddr: string;
  origPort: number;
  respAddr: string;
  respPort: number;
  proto: number;
  kind: string;
  level: ThreatLevel;
}

const VALID_LEVELS: readonly ThreatLevel[] = [
  "VERY_LOW",
  "LOW",
  "MEDIUM",
  "HIGH",
  "VERY_HIGH",
];

function isThreatLevel(value: unknown): value is ThreatLevel {
  return (
    typeof value === "string" &&
    (VALID_LEVELS as readonly string[]).includes(value)
  );
}

const CURATED_TYPENAME_SET: ReadonlySet<string> = new Set(
  CURATED_EVENT_TYPENAMES,
);

// RFC 3339 timestamps returned by REview. The fractional-seconds
// block is optional so tokens produced before REview adopted
// nanosecond precision remain decodable.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function isValidTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

// Rough shape check that covers IPv4 / IPv6 literals without
// taking on a full parser. We only want to reject obviously bogus
// tampered values (empty strings, whitespace, HTML, SQL, etc.) —
// actual routability is REview's concern.
const IP_LITERAL_RE = /^[0-9A-Fa-f:.]+$/;

function isIpLiteral(value: string): boolean {
  if (value.length < 2 || value.length > 45) return false;
  return IP_LITERAL_RE.test(value);
}

function toBase64Url(input: string): string {
  const base64 = Buffer.from(input, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encode an event's composite locator into a URL-safe token.
 *
 * Returns `null` when the event lacks the addressing fields required
 * to locate it later (no `origAddr` / `respAddr`). Callers typically
 * hide the "Open full investigation" affordance in that case.
 */
export function encodeEventLocator(event: EventLocatorSource): string | null {
  const origAddr =
    event.origAddr ??
    (event.origAddrs && event.origAddrs.length > 0 ? event.origAddrs[0] : null);
  if (!origAddr) return null;
  const respAddr =
    event.respAddr ??
    (event.respAddrs && event.respAddrs.length > 0 ? event.respAddrs[0] : null);
  if (!respAddr) return null;
  const payload: EventLocator = {
    sensor: event.sensor,
    time: event.time,
    origAddr,
    origPort: event.origPort ?? 0,
    respAddr,
    respPort: event.respPort ?? 0,
    proto: event.proto ?? 0,
    kind: event.__typename,
    level: event.level,
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode a locator token. Returns `null` for malformed or
 * tampered tokens so the caller can render the documented
 * "event no longer available" state.
 */
export function decodeEventLocator(token: string): EventLocator | null {
  if (!token) return null;
  const json = fromBase64Url(token);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const payload = parsed as Record<string, unknown>;
  const {
    sensor,
    time,
    origAddr,
    origPort,
    respAddr,
    respPort,
    proto,
    kind,
    level,
  } = payload;

  if (
    typeof sensor !== "string" ||
    typeof time !== "string" ||
    typeof origAddr !== "string" ||
    typeof respAddr !== "string" ||
    typeof kind !== "string" ||
    typeof origPort !== "number" ||
    typeof respPort !== "number" ||
    typeof proto !== "number" ||
    !isThreatLevel(level)
  ) {
    return null;
  }

  // Semantic validation — reject well-shaped but nonsensical tokens
  // so the page renders the documented "Invalid event link" state
  // instead of forwarding tampered values to REview. The encoder
  // only ever produces values that satisfy these checks, so this
  // tightens decode without constraining any real caller.
  if (
    sensor.length === 0 ||
    !isValidTimestamp(time) ||
    !isIpLiteral(origAddr) ||
    !isIpLiteral(respAddr) ||
    !CURATED_TYPENAME_SET.has(kind) ||
    !Number.isInteger(origPort) ||
    origPort < 0 ||
    origPort > 65535 ||
    !Number.isInteger(respPort) ||
    respPort < 0 ||
    respPort > 65535 ||
    !Number.isInteger(proto) ||
    proto < 0 ||
    proto > 255
  ) {
    return null;
  }

  return {
    sensor,
    time,
    origAddr,
    origPort,
    respAddr,
    respPort,
    proto,
    kind,
    level,
  };
}

/**
 * Type-narrow the curated `Event` union to events that carry
 * addressing fields. Useful when a caller has an `Event` from the
 * list query and wants to decide whether to expose a
 * "full investigation" link.
 *
 * Subtypes that expose `respAddrs` (plural) rather than a singular
 * responder — notably `MultiHostPortScan` — or `origAddrs` (plural)
 * rather than a singular originator — notably `ExternalDdos` — are
 * addressable when at least one entry is present on the plural
 * field; the encoder picks the first entry as the locator's
 * singular counterpart so the token shape stays stable.
 */
export function isEventAddressable(
  event: Event | EventBase,
): event is Event & { origAddr?: string; origAddrs?: readonly string[] } {
  const source = event as Partial<EventLocatorSource>;
  const hasOrig =
    (typeof source.origAddr === "string" && source.origAddr.length > 0) ||
    (Array.isArray(source.origAddrs) &&
      source.origAddrs.length > 0 &&
      typeof source.origAddrs[0] === "string" &&
      (source.origAddrs[0] as string).length > 0);
  if (!hasOrig) return false;
  if (typeof source.respAddr === "string" && source.respAddr.length > 0) {
    return true;
  }
  const { respAddrs } = source;
  return (
    Array.isArray(respAddrs) &&
    respAddrs.length > 0 &&
    typeof respAddrs[0] === "string" &&
    (respAddrs[0] as string).length > 0
  );
}
