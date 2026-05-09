import { directionsForFilterInput } from "./direction";
import {
  endpointsToEndpointInputs,
  preservePredefinedEndpointInputs,
} from "./endpoint-filter";
import type { Filter } from "./filter";
import {
  type MultiSelectOptionRef,
  selectionForSubmission,
} from "./filter-chips";
import { type DetectionFilterDraft, isConfidenceDefault } from "./filter-draft";
import type {
  EventListFilterInput,
  LearningMethod,
  ThreatLevel,
} from "./types";

/**
 * Categorical option bundles used to normalize drafted selections
 * before submission. Shape matches the drawer's
 * `FilterDrawerOptions` so the same lists can be passed without
 * reshaping, but the type lives in the lib layer to avoid a
 * server→`"use client"` import.
 */
export interface CategoricalFilterOptions {
  levels: readonly MultiSelectOptionRef<ThreatLevel>[];
  countries: readonly MultiSelectOptionRef<string>[];
  learningMethods: readonly MultiSelectOptionRef<LearningMethod>[];
  categories: readonly MultiSelectOptionRef<number>[];
  kinds: readonly MultiSelectOptionRef<string>[];
}

/**
 * Build the structured `Filter` submitted by the Detection drawer's
 * Apply button.
 *
 * When the draft's confidence range is at the `[0, 1]` default, both
 * `confidenceMin` and `confidenceMax` are physically omitted from the
 * returned `EventListFilterInput` — not set to `null`. The drawer
 * treats the default as "no filter", and the GraphQL client forwards
 * whatever object we hand it unchanged (see `src/lib/graphql/client.ts`),
 * so sending explicit `null`s would leave the decision to REview's
 * null-vs-absent semantics. Omitting the keys matches the acceptance
 * criteria ("both fields omitted from submission") and is the safer
 * contract regardless.
 *
 * Any prior `confidenceMin` / `confidenceMax` carried by
 * `currentFilter.input` is also dropped before the new value is
 * applied, so a previous non-default commit cannot bleed through when
 * the user resets the range back to the default.
 */
export function buildAppliedFilter(
  currentFilter: Filter,
  applied: DetectionFilterDraft,
  sensorEndpointLive: boolean = false,
  customerSelectionLive: boolean = false,
  categoricalOptions?: CategoricalFilterOptions,
): Filter {
  if (!applied.startIso || !applied.endIso) {
    throw new Error("buildAppliedFilter requires both startIso and endIso");
  }

  const previousInput: Partial<EventListFilterInput> =
    currentFilter.mode === "structured" ? currentFilter.input : {};
  const {
    confidenceMin: _prevMin,
    confidenceMax: _prevMax,
    directions: _prevDirections,
    endpoints: _prevEndpoints,
    sensors: _prevSensors,
    customers: _prevCustomers,
    // Strip the branch-introduced free-form fields from the previous
    // input so stale values don't survive when the drawer clears them;
    // the drawer-provided `applied` draft is the source of truth below.
    source: _prevSource,
    destination: _prevDestination,
    keywords: _prevKeywords,
    hostnames: _prevHostnames,
    userIds: _prevUserIds,
    userNames: _prevUserNames,
    userDepartments: _prevUserDepartments,
    ...previousRest
  } = previousInput;
  // Only strip the previous categorical values when the caller is
  // wiring the categorical draft fields through — otherwise preserve
  // them so a call that only knows about time/confidence/direction
  // (no `categoricalOptions`) does not silently erase categorical
  // selections carried on the current filter.
  const previousWithoutConfidence: Partial<EventListFilterInput> =
    categoricalOptions
      ? (() => {
          const {
            levels: _prevLevels,
            countries: _prevCountries,
            learningMethods: _prevLearningMethods,
            categories: _prevCategories,
            kinds: _prevKinds,
            ...rest
          } = previousRest;
          return rest;
        })()
      : previousRest;

  const directions = directionsForFilterInput(applied.directions);
  // Predefined endpoint references (e.g. server-defined network groups)
  // have no shape in the `EndpointEntry` UI mirror, so the drawer
  // draft cannot represent them. Pull them off the previous filter
  // input and replay them on top of the rebuilt custom side — the
  // pivot path does the same for the same reason. Without this, an
  // Apply (or saved-filter Save) against a filter carrying a
  // predefined endpoint would silently broaden the filter by writing
  // `endpoints: null` (or only the custom slice).
  const preservedPredefined = preservePredefinedEndpointInputs(
    previousInput.endpoints,
  );
  const customEndpoints = endpointsToEndpointInputs(applied.endpoints);
  const endpoints = [...preservedPredefined, ...customEndpoints];

  const input: EventListFilterInput = {
    ...previousWithoutConfidence,
    start: applied.startIso,
    end: applied.endIso,
    endpoints: endpoints.length > 0 ? endpoints : null,
  };
  if (directions) {
    input.directions = directions;
  }
  if (!isConfidenceDefault(applied)) {
    input.confidenceMin = applied.confidenceMin;
    input.confidenceMax = applied.confidenceMax;
  }
  // Sensors only flow into the submitted filter when the REview
  // sensor-list endpoint is live AND the user picked at least one;
  // every other state strips the field so the fallback contract
  // ("no `sensors` reaches the filter unless ready") holds.
  if (sensorEndpointLive && applied.sensorIds.length > 0) {
    input.sensors = [...applied.sensorIds];
  }

  // Customers (#384). The draft carries numeric IDs for natural
  // in-drawer comparisons; the wire shape is REview's `IDScalar[]`
  // (i.e. `string[]`), so convert at the boundary. An empty draft
  // means "no customer narrowing" — omit the field so REview applies
  // the JWT-carried scope without further restriction. The BFF
  // intersection check (`validateFilterScope`) rejects out-of-scope
  // IDs before any REview round-trip; this code path therefore never
  // needs to "trim" a saved/crafted selection.
  //
  // Reviewer Round 8: customers are also gated on
  // `customerSelectionLive` — true only when the customer cache is
  // `loaded` AND has a non-empty options list. Mirrors the sensor
  // gate so the issue/manual contract holds: the filter submits no
  // `customers` value while the first drawer-open fetch is in flight,
  // after a manual refresh transitions the control into `error`, or
  // on an empty-scope (`No customer access`) session — even when a
  // bookmark / saved filter / pivot URL hydrated the draft with
  // prior IDs. Whatever previous `customers` was on the committed
  // filter is also stripped at the destructure above, so re-applying
  // a stale selection cannot bleed through.
  if (customerSelectionLive && applied.customerIds.length > 0) {
    input.customers = applied.customerIds.map(String);
  }

  // Free-form drawer fields: source/destination are single strings,
  // the rest are tag lists. Empty values are omitted from the input so
  // a cleared field doesn't submit `""` or `[]` to REview.
  const source = applied.source.trim();
  if (source.length > 0) input.source = source;
  const destination = applied.destination.trim();
  if (destination.length > 0) input.destination = destination;
  if (applied.keywords.length > 0) input.keywords = [...applied.keywords];
  if (applied.hostnames.length > 0) input.hostnames = [...applied.hostnames];
  if (applied.userIds.length > 0) input.userIds = [...applied.userIds];
  if (applied.userNames.length > 0) input.userNames = [...applied.userNames];
  if (applied.userDepartments.length > 0) {
    input.userDepartments = [...applied.userDepartments];
  }

  if (categoricalOptions) {
    // `levels` is treated as an open list because the drawer only
    // exposes the three-level subset (`LOW` / `MEDIUM` / `HIGH`)
    // while the schema also defines `VERY_LOW` and `VERY_HIGH`.
    // Without `openList`, picking all three visible values would
    // saturate the option list and drop the field, silently
    // broadening the query to include the two values the user
    // never saw.
    const levels = selectionForSubmission(
      applied.levels,
      categoricalOptions.levels,
      { openList: true },
    );
    if (levels) input.levels = levels;
    const countries = selectionForSubmission(
      applied.countries,
      categoricalOptions.countries,
    );
    if (countries) input.countries = countries;
    const learningMethods = selectionForSubmission(
      applied.learningMethods,
      categoricalOptions.learningMethods,
    );
    if (learningMethods) input.learningMethods = learningMethods;
    const categories = selectionForSubmission(
      applied.categories,
      categoricalOptions.categories,
    );
    if (categories) input.categories = categories;
    // `kinds` is an open-list field — the seed option list is a
    // subset of what REview may surface, so a saturated pick must
    // still submit the explicit list rather than broadening to
    // unseen values.
    const kinds = selectionForSubmission(
      applied.kinds,
      categoricalOptions.kinds,
      { openList: true },
    );
    if (kinds) input.kinds = kinds;
  }

  return { mode: "structured", input };
}
