/**
 * Active-filter chip aggregation for the Detection filter drawer.
 *
 * Implements the Phase Detection-9 chip rule (the umbrella issue
 * shared across categorical multi-selects):
 *
 *   - 0 selected  → no chips (interpreted as "no filter")
 *   - all options selected → no chips (same as "no filter")
 *   - 1–3 selected  → one individual chip per selected value
 *   - more than 3 selected → one aggregate token per field,
 *     e.g. "Level: 5 selected", "Countries: 12"
 *
 * The "all selected = no filter" shortcut only holds for fields
 * whose option list is exhaustive. Fields that surface a seed
 * subset (see `openList`) submit the explicit selection instead —
 * otherwise picking every visible value would silently broaden the
 * query to values the user never saw.
 *
 * The builder is menu-neutral — it knows nothing about the
 * underlying `EventListFilterInput` field names. Callers pass the
 * per-field descriptor and the rule decides the chip shape.
 */

export interface MultiSelectOptionRef<V extends string | number> {
  value: V;
  label: string;
}

export interface MultiSelectFieldChipInput<V extends string | number> {
  /** Stable identifier — used as the chip key prefix. */
  fieldKey: string;
  /** UI label for the field (e.g. "Threat Level"). */
  fieldLabel: string;
  /** All options the field offers (used for the "all selected" check). */
  options: readonly MultiSelectOptionRef<V>[];
  /** Current selection for the field. */
  selected: readonly V[];
  /**
   * Formatter for the aggregate chip's value (e.g. `n => "5 selected"`
   * or `n => String(n)`). Injected rather than baked in so callers
   * can pick the wording — e.g. `Countries: 12` vs
   * `Level: 5 selected`.
   */
  aggregateValue: (count: number) => string;
  /**
   * When `true`, the supplied `options` are a seed subset rather than
   * the full domain of possible values (e.g. Threat Name while no
   * REview-backed completion exists). In that case a "saturated"
   * selection is NOT treated as "no filter" — every pick must still
   * produce chips, otherwise a full visible selection would read as
   * "no filter" to the user while actually only pinning the seen
   * subset. Defaults to `false` (closed list).
   */
  openList?: boolean;
}

export interface ActiveFilterChip {
  /** DOM-stable key for the chip (one `<li>` per chip). */
  key: string;
  /** Which field produced the chip; handy when chips are removable. */
  fieldKey: string;
  /** UI label prefix shown on the chip. */
  label: string;
  /** Text on the chip body. */
  value: string;
  /** True if this is a single aggregate token for the field. */
  aggregate: boolean;
}

/**
 * Build the chips a single multi-select field contributes to the
 * active-filter bar.
 */
export function buildMultiSelectChips<V extends string | number>(
  input: MultiSelectFieldChipInput<V>,
): ActiveFilterChip[] {
  const n = input.selected.length;
  if (n === 0) return [];
  if (!input.openList && n >= input.options.length) return [];
  if (n > 3) {
    return [
      {
        key: `${input.fieldKey}:__agg`,
        fieldKey: input.fieldKey,
        label: input.fieldLabel,
        value: input.aggregateValue(n),
        aggregate: true,
      },
    ];
  }

  const byValue = new Map<V, string>();
  for (const option of input.options) byValue.set(option.value, option.label);

  return input.selected.map((value) => ({
    key: `${input.fieldKey}:${String(value)}`,
    fieldKey: input.fieldKey,
    label: input.fieldLabel,
    value: byValue.get(value) ?? String(value),
    aggregate: false,
  }));
}

/**
 * Normalize a multi-select selection for submission. Returns `null`
 * when the selection is empty or (for a closed list) equal to the
 * full option list — the caller should then omit the field from
 * `EventListFilterInput`. A non-null return is a shallow copy so
 * the filter never aliases a draft array the UI still owns.
 *
 * Pass `{ openList: true }` when the option list is only a seed
 * subset (e.g. Threat Name today). In open-list mode the
 * "saturated = no filter" shortcut is disabled, because picking
 * every visible value must NOT silently broaden the query to
 * values the user never saw.
 */
export function selectionForSubmission<V extends string | number>(
  selected: readonly V[],
  options: readonly MultiSelectOptionRef<V>[],
  { openList = false }: { openList?: boolean } = {},
): V[] | null {
  if (selected.length === 0) return null;
  if (!openList && selected.length >= options.length) return null;
  return selected.slice();
}
