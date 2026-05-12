import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";

import { DetectionUnauthorizedError } from "./errors";
import { SENSOR_LIST_QUERY } from "./queries";
import { jwtCustomerIdsForDetection } from "./server-actions";

const DETECTION_READ = "detection:read";
const TRIAGE_READ = "triage:read";
const CUSTOMERS_ACCESS_ALL = "customers:access-all";

/**
 * A sensor (Node) known to REview, scoped to customers the caller can
 * access.
 *
 * Field mapping at the dispatch boundary (see `listSensors`):
 *
 *   - `id`         ← `customerSensorList.nodes[].nodeId`   (SDL: `ID!`)
 *   - `name`       ← `customerSensorList.nodes[].hostFqdn` (SDL: `String!`)
 *   - `customerId` ← `customerSensorList.nodes[].customerId` (SDL: `Int!`)
 *
 * `id` substitutes directly into `EventListFilterInput.sensors`, which
 * review resolves to `node.profile.hostname` for matching against
 * `Event.sensor` — equal to `hostFqdn` here.
 */
export interface Sensor {
  /** Opaque REview Node ID. Matches `EventListFilterInput.sensors` entries. */
  id: string;
  /** Human-readable sensor name as emitted on `Event.sensor`. */
  name: string;
  /** REview customer ID the sensor belongs to. */
  customerId: number;
}

/**
 * Whether the vendored REview schema at `schemas/review.graphql` exposes
 * the sensor-list query consumed by this module.
 *
 * The REview-side endpoint shipped in review-web 0.33.0 (review 0.50.0)
 * as `customerSensorList`, with one row per Node (Sensor.nodeId: ID!).
 * The constant is retained — not deleted — so a future schema rollback
 * (or a schema bump that removes the field) flips back to `false`
 * automatically via the endpoint-guard test, and `listSensors()`
 * degrades to the `{ endpointAvailable: false }` variant rather than
 * dispatching against a missing field.
 *
 * ## Three-way CI guard
 *
 * `src/__tests__/lib/detection/sensors-endpoint-guard.test.ts` enforces
 * the three-way contract at CI time: the constant must match what the
 * vendored SDL exposes (both `Query.customerSensorList` and
 * `Sensor.nodeId: ID!` must be present). A pre-0.33.0 schema that
 * exposes only `customerSensorList` (without `Sensor.nodeId`) is
 * treated as endpoint-absent so the projection below stays safe.
 * `src/__tests__/lib/detection/sensors.test.ts` additionally asserts
 * that, when the constant is `true`, `listSensors()` dispatches
 * through `graphqlRequest` with `{ role, customerIds }`.
 */
export const SENSOR_LIST_ENDPOINT_AVAILABLE = true as const;

/**
 * Result shape returned by `listSensors()`.
 *
 * Modelled as a discriminated union so consumers are forced, **at the
 * TypeScript type level**, to acknowledge the endpoint-availability
 * state before they can touch `sensors`. A consumer that writes
 * `(await listSensors(session)).sensors.map(...)` fails `tsc --noEmit`
 * because `sensors` does not exist on the `endpoint-absent` variant —
 * which is the "clearly-named compile guard" required by #301's
 * acceptance list.
 *
 * This is intentionally stricter than a shared `sensors: Sensor[]`
 * field on both variants: the previous shape let a consumer treat an
 * empty list returned by the fallback as indistinguishable from an
 * empty list returned by REview (same caller with no sensors assigned
 * to their customer scope), which is precisely the bug the guard is
 * meant to prevent.
 *
 * Use `sensorsOrEmpty()` below to collapse a result into `Sensor[]`
 * when a downstream surface only needs to iterate (e.g. #278 Sensor
 * dropdown options). Consumers that must distinguish "endpoint absent"
 * from "endpoint present but empty" (e.g. #291 event locator, which
 * skips name → ID resolution when the endpoint is absent) branch on
 * the `endpointAvailable` discriminator directly.
 */
export type SensorListResult =
  | { readonly endpointAvailable: false }
  | { readonly endpointAvailable: true; readonly sensors: readonly Sensor[] };

/**
 * Collapse a `SensorListResult` into a flat `readonly Sensor[]`. Returns
 * the empty array when the endpoint is absent from the vendored schema,
 * preserving the issue's "returns an empty list without throwing"
 * fallback contract for callers that do not need the discriminator.
 */
export function sensorsOrEmpty(result: SensorListResult): readonly Sensor[] {
  return result.endpointAvailable ? result.sensors : [];
}

// Wire-shape of the `customerSensorList` payload. Hand-written rather
// than codegen'd: `scripts/codegen-detection-types.mjs` is a fixed
// root-type walker (events only). Keeping this inline matches the rest
// of Detection's "selection set is small, the projection is local"
// pattern. Three scalars, one projection point.
interface SensorListNode {
  customerId: number;
  nodeId: string;
  hostFqdn: string;
}
interface SensorListResponse {
  customerSensorList: {
    nodes: SensorListNode[];
  };
}

/**
 * Return the sensors visible to the caller.
 *
 * ## Authorization
 *
 * Mirrors `searchEvents` / counter actions (see
 * `src/lib/detection/server-actions.ts`). Before any network traffic:
 *
 *   1. Caller must hold `detection:read` OR `triage:read`. The Triage
 *      Tier 2 sensor pivot (#502) reuses this lookup, and the sensor
 *      list is read-only metadata already customer-scoped via the
 *      JWT, so the permission union does not widen what data the
 *      caller can see — it just keeps Tier 2 sensor pivot from
 *      implicitly requiring `detection:read`.
 *   2. The caller's effective `customer_ids` must resolve to a
 *      non-empty list — an empty scope is rejected as a
 *      misconfiguration (except for callers holding
 *      `customers:access-all`; see below).
 *
 * Empty-scope handling intentionally throws `DetectionUnauthorizedError`
 * (not `DetectionForbiddenError`). The `sensor-actions.ts` server
 * action catches the former and maps it to `code: "forbidden"` for
 * the drawer; aligning with `buildDispatchContext`'s `Forbidden` would
 * fall through that catch and surface as a generic `server-error` to
 * the dropdown — a UX regression. Broader Detection auth-error
 * alignment is out of scope for this module.
 *
 * When REview is reached, scope travels on the Context JWT
 * (`signContextJwt(role, customerIds)`), not on query arguments. REview
 * applies the scope from the JWT claim set and returns only sensors
 * belonging to the caller's accessible customers. SystemAdministrator
 * callers ship `customer_ids = undefined` (review's "all customers"
 * wire semantics) so the bootstrap admin on a fresh install reaches
 * the endpoint even before any `customers` rows are materialized;
 * every other role ships the materialized list. The branch is shared
 * with `searchEvents` via {@link jwtCustomerIdsForDetection}.
 *
 * ## Fallback when the endpoint is absent
 *
 * The compile guard and `SENSOR_LIST_ENDPOINT_AVAILABLE` constant are
 * retained even now that the endpoint has shipped: a future REview
 * schema rollback (or accidental removal of `customerSensorList` /
 * `Sensor.nodeId`) flips the endpoint-guard test, the constant goes
 * back to `false`, and this function degrades gracefully to the
 * `{ endpointAvailable: false }` variant instead of dispatching
 * against a missing field. Consumers (#278 dropdown, #291 locator)
 * branch on the discriminator and degrade the same way they did
 * during the pre-rollout window.
 */
export async function listSensors(
  session: AuthSession,
): Promise<SensorListResult> {
  const [hasDetectionRead, hasTriageRead] = await Promise.all([
    hasPermission(session.roles, DETECTION_READ),
    hasPermission(session.roles, TRIAGE_READ),
  ]);
  if (!hasDetectionRead && !hasTriageRead) {
    throw new DetectionUnauthorizedError(
      "Caller lacks the detection:read or triage:read permission.",
    );
  }

  const hasGlobalScope = await hasPermission(
    session.roles,
    CUSTOMERS_ACCESS_ALL,
  );
  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (!hasGlobalScope && customerIds.length === 0) {
    // An access-all caller (in particular the bootstrap System
    // Administrator on a fresh install with no `customers` rows yet)
    // must be able to reach the sensor list — see the symmetric
    // bypass in `buildDispatchContext` (server-actions.ts) for the
    // same rationale. Non-admin sessions with an empty scope still
    // throw so the BFF never leaks an unscoped sensor enumeration.
    throw new DetectionUnauthorizedError(
      "Caller has no assigned customers; Detection requires a customer scope.",
    );
  }

  if (!SENSOR_LIST_ENDPOINT_AVAILABLE) {
    // Defensive branch retained for a future schema rollback. The
    // endpoint-guard test flips the constant back to `false` if the
    // vendored SDL ever loses `customerSensorList` or `Sensor.nodeId`,
    // and the `{ endpointAvailable: false }` variant signals the state
    // to consumers at the type level.
    return { endpointAvailable: false };
  }

  const role = session.roles[0];
  // listSensors runs its own permission + customer-scope gates above
  // (see DetectionUnauthorizedError throws) and reuses
  // `jwtCustomerIdsForDetection` from server-actions.ts for the JWT
  // claim shape. `buildDispatchContext` is filter-oriented (validates
  // `filter.input.customers`) and would change the empty-scope error
  // class to DetectionForbiddenError, which sensor-actions.ts does not
  // catch — see this module's docstring.
  const data = await withReviewErrorMapping(
    // biome-ignore format: keep the override on the helper-name line so
    // scripts/check-dispatch-context.mjs sees `// scope-allowlist:` within
    // the call expression range (helper-name → opening paren).
    graphqlRequest<SensorListResponse>( // scope-allowlist: own auth gate + reused JWT helper (see comment above)
      SENSOR_LIST_QUERY,
      undefined,
      {
        role,
        customerIds: jwtCustomerIdsForDetection(role, customerIds),
      },
    ),
  );

  // Map the wire payload onto the consumer-facing `Sensor` shape.
  // The boundary lives here so the rest of Detection keeps the
  // `{ id, name, customerId }` projection used by #278's dropdown
  // and the page-session cache. SDL field names (`nodeId`,
  // `hostFqdn`) are intentionally not leaked through the public API.
  const sensors: Sensor[] = data.customerSensorList.nodes.map((node) => ({
    id: node.nodeId,
    name: node.hostFqdn,
    customerId: node.customerId,
  }));
  return { endpointAvailable: true, sensors };
}
