import { directionsForFilterInput } from "./direction";
import { endpointsToEndpointInputs } from "./endpoint-filter";
import type { Filter } from "./filter";
import {
  type MultiSelectOptionRef,
  selectionForSubmission,
} from "./filter-chips";
import { type DetectionFilterDraft, isConfidenceDefault } from "./filter-draft";
import type { EventListFilterInput, LearningMethod } from "./types";

/**
 * Categorical option bundles used to normalize drafted selections
 * before submission. Shape matches the drawer's
 * `FilterDrawerOptions` so the same lists can be passed without
 * reshaping, but the type lives in the lib layer to avoid a
 * server→`"use client"` import.
 */
export interface CategoricalFilterOptions {
  levels: readonly MultiSelectOptionRef<number>[];
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
  categoricalOptions?: CategoricalFilterOptions,
): Filter {
  // Both-null is a valid "no time constraint" commit (operator cleared
  // the Period chip and re-applied other fields). Asymmetric pairs are
  // still rejected — the drawer validates them before Apply, so this
  // guard mostly catches programmer errors.
  if (Boolean(applied.startIso) !== Boolean(applied.endIso)) {
    throw new Error(
      "buildAppliedFilter requires both startIso and endIso, or neither",
    );
  }

  const previousInput: Partial<EventListFilterInput> =
    currentFilter.mode === "structured" ? currentFilter.input : {};
  const {
    confidenceMin: _prevMin,
    confidenceMax: _prevMax,
    directions: _prevDirections,
    endpoints: _prevEndpoints,
    // `sensors` is handled separately below: when the sensor endpoint
    // is live the draft is authoritative, but when it isn't the
    // previously committed selection must survive (the operator has
    // no way to interact with the disabled control, so stripping it
    // here would silently broaden the query the moment they apply any
    // unrelated edit like Level or Source). See the sensor branch at
    // the end of this function.
    sensors: _prevSensors,
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
  const endpoints = endpointsToEndpointInputs(applied.endpoints);

  // Strip any previously committed `start` / `end` before applying the
  // draft — the draft is the source of truth. When the draft is in the
  // no-time state (both ISO null), the resulting filter carries no
  // `start` / `end` and the list runs without a time constraint.
  const {
    start: _prevStart,
    end: _prevEnd,
    ...previousWithoutTime
  } = previousWithoutConfidence;
  const input: EventListFilterInput = {
    ...previousWithoutTime,
    endpoints: endpoints.length > 0 ? endpoints : null,
  };
  if (applied.startIso && applied.endIso) {
    input.start = applied.startIso;
    input.end = applied.endIso;
  }
  if (directions) {
    input.directions = directions;
  }
  if (!isConfidenceDefault(applied)) {
    input.confidenceMin = applied.confidenceMin;
    input.confidenceMax = applied.confidenceMax;
  }
  // Sensor handling:
  //   * Endpoint live → the draft is authoritative. A non-empty list
  //     is applied; an empty list clears the committed selection.
  //   * Endpoint not live (loading / error / unavailable) → the
  //     operator has no way to interact with the disabled control,
  //     so the previously committed selection must survive. Dropping
  //     it here would silently broaden the query the moment the
  //     operator applies any unrelated edit during a fetch failure
  //     or before the inventory resolves.
  if (sensorEndpointLive) {
    if (applied.sensorIds.length > 0) {
      input.sensors = [...applied.sensorIds];
    }
  } else if (previousInput.sensors && previousInput.sensors.length > 0) {
    input.sensors = [...previousInput.sensors];
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
    const levels = selectionForSubmission(
      applied.levels,
      categoricalOptions.levels,
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
