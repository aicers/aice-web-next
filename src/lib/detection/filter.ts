import { DetectionNotImplementedError } from "./errors";
import type { EventListFilterInput } from "./types";

/**
 * Discriminated union the Detection server actions accept.
 *
 * `mode: "structured"` carries a concrete `EventListFilterInput`
 * and is the only mode handled in v1. `mode: "query"` is reserved
 * for the future search-language front-end; the shape is stable so
 * callers that need to accept either form can be written today and
 * will keep compiling when the second branch is wired.
 */
export type Filter =
  | { mode: "structured"; input: EventListFilterInput }
  | { mode: "query"; text: string };

/**
 * Normalize a `Filter` into an `EventListFilterInput` the BFF can
 * forward to REview. The `customers` field is a query-surface
 * dimension — authorization and customer scoping travel in the
 * Context JWT attached by `graphqlRequest`, not in the filter.
 *
 * Defense-in-depth (#384): the BFF independently rejects any
 * `filter.input.customers` entry outside the caller's effective
 * scope before this normalization runs (see
 * `validateFilterScope` in `./filter-customer-scope.ts`, called
 * from `buildDispatchContext` in `./server-actions.ts`). A passing
 * filter therefore reaches REview with a `customers` list that is
 * already a subset of the JWT-carried scope; REview applies its own
 * intersection on top, but the BFF is no longer relying on REview
 * as the only enforcement point.
 *
 * v1: throws on `mode: "query"`. The umbrella issue calls this the
 * "NotImplemented" branch — callers catch
 * `DetectionNotImplementedError` if they need to fall back.
 */
export function toEventListFilterInput(filter: Filter): EventListFilterInput {
  if (filter.mode === "query") {
    throw new DetectionNotImplementedError(
      'Filter mode "query" is not implemented yet; use mode "structured".',
    );
  }
  return filter.input;
}
