/**
 * Auto-generate a tab label from a filter summary — Phase
 * Detection-10.
 *
 * The shell drives this helper with the same localized chip values
 * the active filter bar renders (`Last 1h`, `High`, `Outbound`, …),
 * so the tab title stays in sync with the visible chips without
 * re-deriving them. A manual rename short-circuits this helper: the
 * tab's persisted `name` is used verbatim and this function is not
 * called.
 */

import type { EndpointChip } from "./endpoint-filter";
import type { FilterChip } from "./filter-summary";

export interface AutoTabNameLabels {
  /** Placeholder for a tab with no filter (blank `+` tab). */
  emptyTab: string;
  /** Separator between label tokens (e.g. `" · "`). */
  separator: string;
  /** Suffix rendered when more chips exist than the cap. */
  moreSuffix: (count: number) => string;
}

/** Maximum chip values concatenated into the auto-generated name. */
export const AUTO_TAB_NAME_CHIP_CAP = 2;

/**
 * Derive a short human-readable name from a summarized chip list.
 *
 * Strategy:
 *   - No chips → `labels.emptyTab` (blank tab).
 *   - Within the {@link AUTO_TAB_NAME_CHIP_CAP} budget → join the
 *     visible tokens with `labels.separator` (e.g. `Last 1h · High`).
 *   - Over budget → pick a head of up to `cap` tokens and append a
 *     `+N` suffix.
 *
 * When both structured and endpoint chips are present and the total
 * would overflow, the head is built with **at least one endpoint
 * token reserved** — otherwise two tabs like `Last 1h + High + Src A`
 * and `Last 1h + High + Dst B` would both collapse to `Last 1h · High
 * · +1` and endpoint-only context switches would be invisible on the
 * strip. Reserving the endpoint slot trades the second structured
 * token for the first endpoint token in that case, which keeps the
 * auto names distinct.
 *
 * Aggregate chips (Keywords: 7) contribute their aggregate token
 * verbatim; they already read as a summary.
 *
 * Endpoint chips ride alongside the structured-filter chips: the
 * active filter bar renders them in a separate strip, but they are
 * also a filter contribution, so two tabs that differ only by
 * endpoint rows must produce different auto-names. Their chip
 * `label` already carries the direction prefix + raw value (`Src
 * 1.2.3.4`) and the aggregate form (`Network: N rules`) is already
 * summary-ready, so they concatenate cleanly with the structured
 * chips' `value` tokens.
 */
export function buildAutoTabName(
  chips: readonly FilterChip[],
  labels: AutoTabNameLabels,
  endpointChips: readonly EndpointChip[] = [],
): string {
  const structuredTokens = chips.map((c) => c.value);
  const endpointTokens = endpointChips.map((c) => c.label);
  const total = structuredTokens.length + endpointTokens.length;
  if (total === 0) return labels.emptyTab;
  const cap = AUTO_TAB_NAME_CHIP_CAP;

  let head: string[];
  if (endpointTokens.length === 0) {
    head = structuredTokens.slice(0, cap);
  } else if (structuredTokens.length === 0) {
    head = endpointTokens.slice(0, cap);
  } else {
    // Mixed case: reserve one slot for an endpoint token so an
    // endpoint-only context switch is not flattened by the cap.
    const structuredHead = structuredTokens.slice(0, Math.max(cap - 1, 0));
    const endpointHead = endpointTokens.slice(
      0,
      Math.max(cap - structuredHead.length, 0),
    );
    head = [...structuredHead, ...endpointHead];
  }

  if (total <= head.length) return head.join(labels.separator);
  const extra = total - head.length;
  return `${head.join(labels.separator)}${labels.separator}${labels.moreSuffix(extra)}`;
}
