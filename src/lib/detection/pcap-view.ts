"use server";

import { getCurrentSession } from "@/lib/auth/session";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";
import { ReviewForbiddenError } from "@/lib/review/errors";

import { DetectionForbiddenError, DetectionUnauthorizedError } from "./errors";
import { fetchDetectionPcap } from "./server-actions";

/**
 * Result of loading the parsed PCAP for the Investigation PCAP tab.
 * A discriminated union (never the raw error) so the tab can render a
 * distinct forbidden / unavailable / error panel without conflating
 * "denied" with "could not load" (#405 guardrail). `parsedPcap` is the
 * empty string when Giganto has no capture for the event — the tab
 * renders the empty state in that case.
 */
export type PcapViewResult =
  | { status: "ok"; parsedPcap: string }
  | { status: "forbidden" }
  | { status: "unavailable" }
  | { status: "error" };

/**
 * Server action invoked by the PCAP tab on first activation. Fetches
 * the parsed (human-readable) PCAP for a Detection event from Giganto.
 * Authorization is enforced transitively via `fetchDetectionPcap` →
 * `buildDispatchContext` (`detection:read` + customer scope). The
 * caller passes the event's `sensor` and `time` (its `requestTime`);
 * Giganto further scopes the capture to the caller's sensors /
 * customers via the Context JWT, so a tampered argument cannot widen
 * access.
 */
export async function loadEventPcap(
  sensor: string,
  requestTime: string,
): Promise<PcapViewResult> {
  const session = await getCurrentSession();
  if (!session) return { status: "forbidden" };
  if (!sensor || Number.isNaN(Date.parse(requestTime))) {
    return { status: "error" };
  }
  try {
    const pcap = await fetchDetectionPcap(session, sensor, requestTime);
    return { status: "ok", parsedPcap: pcap.parsedPcap };
  } catch (err) {
    if (
      err instanceof DetectionForbiddenError ||
      err instanceof DetectionUnauthorizedError ||
      err instanceof ReviewForbiddenError
    ) {
      return { status: "forbidden" };
    }
    if (err instanceof ExternalServiceUnavailableError) {
      return { status: "unavailable" };
    }
    return { status: "error" };
  }
}
