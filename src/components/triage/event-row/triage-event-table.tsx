"use client";

import type { ReactNode } from "react";

/**
 * Shared row/cell renderer for the Triage event table (#554).
 *
 * Both the Asset detail panel (#451 / #476 / #452) and the Story
 * detail member table (#490) render the same per-event row layout
 * over different source shapes. This module owns the table chrome,
 * the cell layout, the unified `baselineScore` formatter, and the
 * reserved `protectedByStory` marker slot — surfaces normalize their
 * source rows into the {@link TriageEventRow} view-model and hand
 * them to {@link TriageEventTable}.
 *
 * Per-surface column visibility (the Story member table's optional
 * `origAddr` / `respAddr` columns) is gated by the presence of the
 * corresponding header label in {@link TriageEventTableLabels}. The
 * asset surface omits those labels and the columns collapse out.
 */

/**
 * Lowest-common-denominator view-model carried by one row of the
 * shared event table.
 *
 * `time` is a pre-formatted display string; each surface decides how
 * to render its source ISO (the asset side runs `formatDateTime`
 * against the active timezone; the story side passes the raw
 * `event_time_iso` literal per #547's existing output). Keeping the
 * formatter on the caller side preserves the per-surface time
 * formatting contract that this issue is not modifying.
 */
export interface TriageEventRow {
  /** Stable per-row React key. */
  key: string;
  /** Pre-formatted timestamp string for the leading cell. */
  time: string;
  /**
   * Event kind label. Asset rows pass the `__typename` GraphQL
   * discriminator; Story member rows pass the persisted
   * `event_group_member.kind` literal — both render verbatim.
   */
  kind: string;
  /**
   * Threat category. `null` renders as an em-dash so the cell
   * never collapses; both surfaces share that contract.
   */
  category: string | null;
  /**
   * Read-time baseline score in `[0, 1]`. `null` only on Story
   * member rows whose `event_time` falls outside the menu period
   * (#547's LEFT JOIN against the period-scoped cohort) — the
   * shared formatter renders these as `—`. Asset rows never carry
   * `null` today but the renderer accepts the wider type so a
   * single formatter covers both surfaces.
   */
  baselineScore: number | null;
  /**
   * Optional originator address. Surfaced only when the table is
   * configured with {@link TriageEventTableLabels.origAddrColumn};
   * `null` renders as `—`. Asset rows do not opt into this column.
   */
  origAddr?: string | null;
  /**
   * Optional responder address. Same gating contract as
   * {@link origAddr}.
   */
  respAddr?: string | null;
  /**
   * Reserved per-row marker slot for #471. When present the table's
   * `renderProtectedByStoryMarker` callback is invoked with the
   * payload and the result is prepended into the leading cell.
   *
   * Today every production caller leaves this `undefined` and the
   * leading cell renders exactly as it did before this slot
   * existed — no marker affordance, no whitespace adjustment.
   * #471 fills the slot in once the Story-protected slider lands.
   */
  protectedByStory?: { score: number };
}

/**
 * Column header labels. Optional address-column labels gate the
 * Story-only `origAddr` / `respAddr` columns: pass them when those
 * columns should render, omit them on the asset surface.
 */
export interface TriageEventTableLabels {
  timeColumn: string;
  kindColumn: string;
  categoryColumn: string;
  scoreColumn: string;
  /**
   * Originator-address column header. Presence enables the column;
   * absence collapses it out (asset surface contract).
   */
  origAddrColumn?: string;
  /**
   * Responder-address column header. Same gating contract as
   * {@link origAddrColumn}.
   */
  respAddrColumn?: string;
}

/**
 * Unified `baselineScore` formatter (#554 design decision). Renders
 * the asset-side numeric format for non-null values (no minimum-
 * fraction-digits padding) and an em-dash for `null`.
 */
const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

export function formatBaselineScore(score: number | null): string {
  return score === null ? "—" : SCORE_FORMAT.format(score);
}

export interface TriageEventTableProps {
  rows: ReadonlyArray<TriageEventRow>;
  labels: TriageEventTableLabels;
  /**
   * Test-only / future-#471 hook. When supplied, the renderer is
   * invoked for every row carrying {@link TriageEventRow.protectedByStory}
   * and the result is rendered at the start of the leading cell.
   * Production callers leave this undefined today (#471 wires the
   * real marker once the slider ships).
   */
  renderProtectedByStoryMarker?: (props: { score: number }) => ReactNode;
}

export function TriageEventTable({
  rows,
  labels,
  renderProtectedByStoryMarker,
}: TriageEventTableProps) {
  const showOrig = labels.origAddrColumn !== undefined;
  const showResp = labels.respAddrColumn !== undefined;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
        <tr className="border-b">
          <th scope="col" className="py-2 pr-2 text-left font-medium">
            {labels.timeColumn}
          </th>
          <th scope="col" className="py-2 pr-2 text-left font-medium">
            {labels.kindColumn}
          </th>
          <th scope="col" className="py-2 pr-2 text-left font-medium">
            {labels.categoryColumn}
          </th>
          {showOrig ? (
            <th scope="col" className="py-2 pr-2 text-left font-medium">
              {labels.origAddrColumn}
            </th>
          ) : null}
          {showResp ? (
            <th scope="col" className="py-2 pr-2 text-left font-medium">
              {labels.respAddrColumn}
            </th>
          ) : null}
          <th scope="col" className="py-2 text-right font-medium">
            {labels.scoreColumn}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TriageEventTableRow
            key={row.key}
            row={row}
            showOrig={showOrig}
            showResp={showResp}
            renderProtectedByStoryMarker={renderProtectedByStoryMarker}
          />
        ))}
      </tbody>
    </table>
  );
}

interface TriageEventTableRowProps {
  row: TriageEventRow;
  showOrig: boolean;
  showResp: boolean;
  renderProtectedByStoryMarker?: (props: { score: number }) => ReactNode;
}

function TriageEventTableRow({
  row,
  showOrig,
  showResp,
  renderProtectedByStoryMarker,
}: TriageEventTableRowProps) {
  // Marker is rendered ONLY when both the row carries the payload AND
  // the surface supplied a renderer. Either side missing leaves the
  // leading cell unchanged so today's `protectedByStory === undefined`
  // production callers render no affordance and no whitespace shift.
  const marker =
    row.protectedByStory !== undefined && renderProtectedByStoryMarker
      ? renderProtectedByStoryMarker(row.protectedByStory)
      : null;
  return (
    <tr className="border-b last:border-0" data-testid="triage-event-row">
      <td
        className="py-1.5 pr-2 font-mono text-xs"
        data-testid="triage-event-row-time"
      >
        {marker}
        {row.time}
      </td>
      <td className="py-1.5 pr-2" data-testid="triage-event-row-kind">
        {row.kind}
      </td>
      <td
        className="py-1.5 pr-2 text-muted-foreground"
        data-testid="triage-event-row-category"
      >
        {row.category ?? "—"}
      </td>
      {showOrig ? (
        <td
          className="py-1.5 pr-2 font-mono text-xs text-muted-foreground"
          data-testid="triage-event-row-orig-addr"
        >
          {row.origAddr ?? "—"}
        </td>
      ) : null}
      {showResp ? (
        <td
          className="py-1.5 pr-2 font-mono text-xs text-muted-foreground"
          data-testid="triage-event-row-resp-addr"
        >
          {row.respAddr ?? "—"}
        </td>
      ) : null}
      <td
        className="py-1.5 text-right font-mono"
        data-testid="triage-event-row-score"
      >
        {formatBaselineScore(row.baselineScore)}
      </td>
    </tr>
  );
}
