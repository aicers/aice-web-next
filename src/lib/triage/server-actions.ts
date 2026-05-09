import "server-only";

import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import type { EventListFilterInput } from "@/lib/detection";
import { graphqlRequest } from "@/lib/graphql/client";
import { withReviewErrorMapping } from "@/lib/review/error-mapping";

import { aggregateTriageEvents } from "./aggregate";
import { TriageForbiddenError, TriageUnauthorizedError } from "./errors";
import type { TriagePeriod } from "./period";
import { TRIAGE_EVENT_LIST_QUERY } from "./queries";
import {
  TRIAGE_HARD_EVENT_CAP,
  type TriageEvent,
  type TriageEventListResult,
  type TriageLoadResult,
} from "./types";

const TRIAGE_READ = "triage:read";
const CUSTOMERS_ACCESS_ALL = "customers:access-all";
const SYSTEM_ADMINISTRATOR = "System Administrator";

/** Page size used per `eventList` round-trip while paginating to the cap. */
const TRIAGE_PAGE_SIZE = 500;

interface TriageEventListVariables extends Record<string, unknown> {
  filter: EventListFilterInput;
  first: number;
  after: string | null;
}

interface TriageDispatchContext {
  role: string;
  /** Materialized customer scope; never empty when `hasGlobalScope` is false. */
  customerIds: number[];
  /** True when the caller holds `customers:access-all`. */
  hasGlobalScope: boolean;
}

/**
 * Verify `triage:read`, resolve the caller's customer scope, and
 * reject empty-scope non-admins before any REview round-trip. The
 * shape mirrors Detection's `buildDispatchContext` so the static
 * dispatch-context guard (`pnpm check:scope`) recognises this file
 * as an allowlisted server-action module.
 */
async function buildDispatchContext(
  session: AuthSession,
): Promise<TriageDispatchContext> {
  if (!(await hasPermission(session.roles, TRIAGE_READ))) {
    throw new TriageUnauthorizedError(
      "Caller lacks the triage:read permission.",
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
    throw new TriageForbiddenError(
      "Caller has no assigned customers; Triage requires a customer scope.",
    );
  }
  return { role: session.roles[0], customerIds, hasGlobalScope };
}

/**
 * Derive the Context JWT's `customer_ids` claim. Mirrors Detection's
 * `jwtCustomerIdsForDetection`: review's `validate_context_jwt`
 * accepts `customer_ids = None` only for `Role::SystemAdministrator`,
 * so the JWT omits the field for the bootstrap admin and ships the
 * materialized list for every other caller.
 */
function jwtCustomerIdsForTriage(
  ctx: Pick<TriageDispatchContext, "role" | "customerIds">,
): number[] | undefined {
  return ctx.role === SYSTEM_ADMINISTRATOR ? undefined : ctx.customerIds;
}

/**
 * Fetch up to {@link TRIAGE_HARD_EVENT_CAP} events for the supplied
 * period, then aggregate them into the Triage funnel + asset list.
 *
 * Cursor pagination matches Detection's contract: the first page uses
 * `after: null`; each subsequent page passes the previous response's
 * `pageInfo.endCursor`. Iteration stops on the first of:
 *   - `pageInfo.hasNextPage === false`
 *   - the accumulator reaches `TRIAGE_HARD_EVENT_CAP`
 *
 * The flag returned to the caller — `truncated` — is `true` when the
 * cap was hit AND REview reports more pages remain. A loaded slice
 * that exactly reached the cap on the final page is not "truncated"
 * because the operator did see every event in the period.
 */
export async function loadTriagePeriod(
  session: AuthSession,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<TriageLoadResult> {
  const ctx = await buildDispatchContext(session);

  const filter: EventListFilterInput = {
    start: period.startIso,
    end: period.endIso,
  };
  const jwtCustomerIds = jwtCustomerIdsForTriage(ctx);

  const events: TriageEvent[] = [];
  let cursor: string | null = null;
  let truncated = false;
  // Bound the loop independently of `hasNextPage` so a misbehaving
  // backend can't wedge the page in an infinite fetch.
  const maxPages = Math.ceil(TRIAGE_HARD_EVENT_CAP / TRIAGE_PAGE_SIZE) + 1;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const remaining = TRIAGE_HARD_EVENT_CAP - events.length;
    if (remaining <= 0) break;
    const first = Math.min(TRIAGE_PAGE_SIZE, remaining);
    const data: TriageEventListResult = await withReviewErrorMapping(
      graphqlRequest<TriageEventListResult, TriageEventListVariables>(
        TRIAGE_EVENT_LIST_QUERY,
        { filter, first, after: cursor },
        { role: ctx.role, customerIds: jwtCustomerIds },
        signal,
      ),
    );
    const page = data.eventList;
    events.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      break;
    }
    cursor = page.pageInfo.endCursor;
    if (events.length >= TRIAGE_HARD_EVENT_CAP) {
      truncated = true;
      break;
    }
  }

  return aggregateTriageEvents(events, truncated);
}
