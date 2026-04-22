"use server";

import { getCurrentSession } from "@/lib/auth/session";
import {
  DetectionUnauthorizedError,
  listSensors,
  type Sensor,
  sensorsOrEmpty,
} from "@/lib/detection";

export type FetchSensorsResult =
  | {
      ok: true;
      /**
       * When `false`, the REview vendored schema does not yet
       * expose the sensor-list query. The drawer shows the same
       * "Coming soon" affordance used for Customer until REview
       * ships the endpoint.
       */
      endpointAvailable: boolean;
      sensors: Array<Pick<Sensor, "id" | "name" | "customerId">>;
    }
  | { ok: false; code: "unauthenticated" | "forbidden" | "server-error" };

/**
 * Client-callable wrapper around `listSensors` for the filter
 * drawer. Returns a flat, serialization-friendly shape so the
 * drawer can render options without re-exporting server-only
 * modules. Authorization travels in the Context JWT via
 * `listSensors`; the result is already scoped to the caller's
 * accessible customers.
 *
 * Does not cache on the server — the drawer caches the result for
 * the tab session so repeated opens don't re-hit the endpoint.
 */
export async function fetchSensors(): Promise<FetchSensorsResult> {
  const session = await getCurrentSession();
  if (!session) {
    return { ok: false, code: "unauthenticated" };
  }

  try {
    const result = await listSensors(session);
    const sensors = sensorsOrEmpty(result).map((s) => ({
      id: s.id,
      name: s.name,
      customerId: s.customerId,
    }));
    return {
      ok: true,
      endpointAvailable: result.endpointAvailable,
      sensors,
    };
  } catch (err) {
    if (err instanceof DetectionUnauthorizedError) {
      return { ok: false, code: "forbidden" };
    }
    return { ok: false, code: "server-error" };
  }
}
