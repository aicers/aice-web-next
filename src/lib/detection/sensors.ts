import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";

import { DetectionUnauthorizedError } from "./errors";

const DETECTION_READ = "detection:read";

/**
 * A sensor (Node) known to REview, scoped to customers the caller can
 * access. The exact field set is a product of the REview query signature
 * and will be finalized when the endpoint lands — see
 * `SENSOR_LIST_ENDPOINT_AVAILABLE` below.
 */
export interface Sensor {
  /** Opaque REview Node ID. Matches `EventListFilterInput.sensors` entries. */
  id: string;
  /** Human-readable sensor name as emitted on `Event.sensor`. */
  name: string;
  /** REview customer ID the sensor belongs to. */
  customerId: string;
}

/**
 * Whether the vendored REview schema at `schemas/review.graphql` exposes
 * the sensor-list query consumed by this module.
 *
 * The REview-side endpoint is being added in a follow-up schema bump
 * (tracked by #295). Until that bump reaches this repo's
 * `schemas/review.graphql`, this flag stays `false` and `listSensors()`
 * short-circuits to the `endpoint-absent` variant — see the fallback
 * note on `listSensors()`.
 *
 * ## Three-way CI guard
 *
 * When REview ships the endpoint, flip this constant to `true` in the
 * **same PR** that bumps the vendored schema and wires the inline
 * `parse(...)` dispatch.
 * `src/__tests__/lib/detection/sensors-endpoint-guard.test.ts` enforces
 * the three-way contract at CI time — flipping the constant without a
 * matching schema field fails, and schema drift without a constant
 * flip fails.
 * `src/__tests__/lib/detection/sensors.test.ts` additionally asserts
 * that, when the constant is `true`, `listSensors()` dispatches through
 * `graphqlRequest` with `{ role, customerIds }` — so flipping the
 * constant while leaving the dispatch body a placeholder also fails CI.
 * The schema bump, constant flip, and dispatch wiring therefore cannot
 * land piecemeal.
 */
export const SENSOR_LIST_ENDPOINT_AVAILABLE = false as const;

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

/**
 * Return the sensors visible to the caller.
 *
 * ## Authorization
 *
 * Mirrors `searchEvents` / counter actions (see
 * `src/lib/detection/server-actions.ts`). Before any network traffic:
 *
 *   1. Caller must hold `detection:read`.
 *   2. The caller's effective `customer_ids` must resolve to a
 *      non-empty list — an empty scope is rejected as a
 *      misconfiguration.
 *
 * When REview is reached, scope travels on the Context JWT
 * (`signContextJwt(role, customerIds)`), not on query arguments. REview
 * applies the scope from the JWT claim set and returns only sensors
 * belonging to the caller's accessible customers.
 *
 * ## Fallback when the endpoint is absent
 *
 * If `SENSOR_LIST_ENDPOINT_AVAILABLE` is `false` (REview has not yet
 * published the query in the vendored schema), this function resolves
 * to the `{ endpointAvailable: false }` variant **instead of throwing**.
 * Pass the result through `sensorsOrEmpty()` to recover the "empty
 * list" iteration shape — the two consumers degrade gracefully:
 *
 *   - #278 Sensor dropdown: renders with no options — the multi-select
 *     is still usable once REview ships the endpoint without any
 *     client-side refactor.
 *   - #291 event locator: skips name → ID resolution and omits
 *     `sensors: [<id>]` from the tight filter (same behaviour as a
 *     name mismatch / out-of-scope event).
 *
 * The fallback is **after** the authorization check, not before: an
 * unauthorized caller is rejected even while the endpoint is missing,
 * so the auth contract is uniform regardless of schema state.
 */
export async function listSensors(
  session: AuthSession,
): Promise<SensorListResult> {
  if (!(await hasPermission(session.roles, DETECTION_READ))) {
    throw new DetectionUnauthorizedError(
      "Caller lacks the detection:read permission.",
    );
  }

  const customerIds = await resolveEffectiveCustomerIds(
    session.accountId,
    session.roles,
  );
  if (customerIds.length === 0) {
    throw new DetectionUnauthorizedError(
      "Caller has no assigned customers; Detection requires a customer scope.",
    );
  }

  if (!SENSOR_LIST_ENDPOINT_AVAILABLE) {
    // REview has not yet published the sensor-list query in the
    // vendored schema (#295). The `endpoint-absent` variant signals
    // this state to consumers at the type level — see
    // `SENSOR_LIST_ENDPOINT_AVAILABLE` for the promote-to-live
    // procedure.
    return { endpointAvailable: false };
  }

  // When REview ships `sensorList` (or `sensorsForCustomers` — exact
  // identifier TBD), add the `parse(...)` document to `./queries.ts`
  // and dispatch here via `graphqlRequest` with
  // `{ role: session.roles[0], customerIds }`. The customer scope MUST
  // travel on the Context JWT, not as a query argument — mirror the
  // contract in `buildDispatchContext` (server-actions.ts). The
  // `endpointAvailable: true` discriminator must be set on the returned
  // object so the type-level guard in `SensorListResult` narrows the
  // `sensors` field for consumers.
  //
  // Unreachable while SENSOR_LIST_ENDPOINT_AVAILABLE is the literal
  // `false`; the narrowed type documents the intent, and the
  // behavioural guard in `sensors.test.ts` (which imports the real
  // constant and asserts dispatch when it is `true`) prevents this
  // branch from staying a no-op if the constant is ever flipped.
  return { endpointAvailable: true, sensors: [] };
}
