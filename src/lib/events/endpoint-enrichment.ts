"use server";

import { getCurrentSession } from "@/lib/auth/session";
import { lookupIpLocation } from "@/lib/detection";

import type { EndpointEnrichmentMap } from "./endpoint-enrichment-types";

/**
 * Lazy endpoint enrichment. Server action invoked by the
 * Investigation page's Endpoints tab when it first activates. The
 * caller passes the list of unique addresses to resolve — for
 * single-responder events that is `[origAddr, respAddr]`, for
 * array-responder subtypes (e.g. MultiHostPortScan) it includes
 * every `respAddrs` entry so each destination card can render its
 * own country / region / ISP row.
 *
 * Authorization is enforced transitively via `lookupIpLocation` →
 * `buildDispatchContext`. Returns an empty map when no session is
 * present; the client renders the tab skeleton without enrichment
 * rather than failing the whole page.
 */
export async function fetchEndpointEnrichments(
  addresses: readonly string[],
): Promise<EndpointEnrichmentMap> {
  const session = await getCurrentSession();
  if (!session) return {};
  const unique = Array.from(
    new Set(
      addresses.filter(
        (addr): addr is string => typeof addr === "string" && addr.length > 0,
      ),
    ),
  );
  if (unique.length === 0) return {};
  const pairs = await Promise.all(
    unique.map(async (addr) => {
      const location = await lookupIpLocation(session, addr);
      return [addr, location] as const;
    }),
  );
  return Object.fromEntries(pairs);
}
