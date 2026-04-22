# Detection

The Detection page is accessed from the sidebar. It is the hub for
investigating detection results produced by the backend — filtering,
reviewing, and drilling into individual findings.

Viewing the page requires the `detection:read` permission. The
built-in roles Security Monitor, Tenant Administrator, and System
Administrator receive this permission by default. Custom roles that
grant `detection:read` also qualify.

![Detection page](../assets/detection-en.svg)

> The figure above is a wireframe stand-in. The page depends on the
> REview backend, which the authoring worktree has no access to.
> A real screenshot replaces the wireframe once a staging environment
> is available.

## Layout

The page is organised into four regions. The Result list is the
hero of the workspace; the supporting regions stay compact so they
do not crowd it out.

### Saved / Recommended rail

A slim rail on the left lists two sections:

- **Recommended Filter** — curated starting points.
- **Saved Filters** — filters you have saved yourself.

On narrow viewports the rail collapses to icons only. On desktop
widths it expands to show the section headings.

### Top bar

The top of the main region holds the **Filters** button and the
**active filter chip bar**. Clicking **Filters** opens the filter
drawer on the right; the chip bar to its right reflects the filter
currently applied to the active tab.

### Result list

The result list fills most of the screen and renders one entry per
detection event. On page entry the default filter (**Last 1 hour**)
runs automatically, so the page is never empty on first view.

Each entry is laid out across two lines:

- Line 1 — severity badge, time, kind / attack-kind, MITRE
  category, confidence (two decimals), and an optional triage
  summary (`policies · max-score`).
- Line 2 — `source IP:port (country) → destination IP:port (country)`
  followed by the sensor name. When an event ships array-valued
  addressing (e.g. `MultiHostPortScan` or `ExternalDdos`), the
  list shows the first entry on each side with an inline
  **`+N more`** affordance. Clicking `+N more` opens a popover
  listing every collapsed address — or, for scan subtypes that
  carry a port array (`PortScan`), every collapsed port — so the
  hidden values are still inspectable without leaving the list;
  the Investigation view remains the place to see everything an
  event carries.

#### Header

Above the list the count and range render as
`Detected Events <range> / <totalCount>` — for example
`Detected Events 1-50 / 1,284` for the first page of a 1 284-event
result set — alongside an **Updated** indicator, a **Refresh**
affordance, and a **Download CSV** button (the latter is disabled
— CSV export wires up in a later phase).

#### Row interactions

- Clicking the body of a row opens the Quick peek inspector. At
  wide viewports (≥ 1280 px) the inspector docks inline as a
  right-hand pane — the result list shrinks proportionally to
  make room. At narrower widths the inspector slides in as an
  overlay drawer so the list keeps its full width. Either form
  shows the selected event's summary header (severity, time,
  kind, sensor) and a jump into the full Investigation view. The
  detail panes land in a later phase; until then the rest of the
  pane carries a clear "coming soon" placeholder.
- The dedicated **Open investigation** affordance at the right end
  of each row jumps to the full Investigation view. Host-based
  events that carry no source / destination addressing (e.g.
  `ExtraThreat`, `WindowsThreat`) cannot be resolved by the
  locator, so the affordance is hidden on those rows rather than
  rendering a button that does nothing.

#### Responsive strategy

The list uses density rather than column drop. As the viewport
narrows, spacing tightens and the source / destination pair
stacks vertically. Severity, time, kind, and addressing remain
visible at every supported width.

### Empty, loading, and error states

- A query that returns zero results renders a clear "no matches"
  message with guidance to widen the filter or remove a chip.
- While a query is in flight the header shows a spinning refresh
  icon and the body retains the previous results.
- A failed query swaps the body for a single error message; the
  Refresh affordance re-runs the query.

### Analytics strip

Below the list, an Analytics strip is reserved for aggregate views
of the current result set. It is collapsed by default; expanding it
reveals an empty placeholder panel in this phase.

## Active filter chip bar

The chip bar above the list reflects every applied filter at all
times — the drawer being closed does not hide the active filter.

- **Single-valued fields** (Period, Source, Destination,
  confidence min / max) render their value directly,
  e.g. `Source: 10.0.0.5`.
- **Array fields with three or fewer entries** render as one chip
  per value, e.g. three Hostname chips.
- **Larger arrays collapse into an aggregate chip** carrying the
  count, e.g. `Hostnames: 7 selected`. Activating the chip body
  opens an inline popover listing the underlying values so the
  collapsed set stays inspectable without round-tripping through
  the drawer; the `×` removes the entire field.
- Pressing `×` on any chip is a self-contained commit: the field
  (or single entry, for per-value chips on an array) is removed
  immediately and the query re-runs. The Apply button in the
  drawer is reserved for batching multi-field edits, not for
  one-shot removals.
- Clicking the body of a **Period** or **Range** chip opens the
  filter drawer so you can adjust the time window — those are the
  controls the drawer exposes in this phase.
- Clicking the body of a non-aggregate chip for a field without
  dedicated drawer controls yet (Source, Destination, Kind,
  Hostname, …) opens a small **value popover** instead. The popover
  shows the committed value, explains that dedicated drawer
  controls land in a later phase, and provides an in-popover
  **Remove from filter** button alongside the chip's `×`. This gives
  every chip body a meaningful activation path today without
  pretending the drawer can edit a field it has no control for yet.
  Once a later phase adds the matching drawer control, the chip's
  body switches to opening the drawer focused on that field.

The summarisation logic lives in
`@/lib/detection/summarize-filter`, a pure helper shared by
everything that needs to render chips so the visible labels and
removal semantics are guaranteed to stay in sync.

> **Forward compatibility — query mode.** The `Filter` type carries
> a future `mode: "query"` branch for a search-language UI. While
> v1 only implements `mode: "structured"`, the chip bar is wired to
> ignore per-field decomposition for the query branch and will
> instead render the query text as a single editable pill in a
> later phase. See the umbrella's Forward compatibility section for
> background.

## Filter drawer

The filter drawer is where you describe the window of detection
events you want to look at. It opens from the **Filters** button in
the top bar and slides in from the right.

![Detection filter drawer](../assets/detection-drawer-en.png)

### Period

The **Period** section exposes the common relative windows as
chips: `Last 1 hour`, `Last 12 hours`, `Last 1 day`, `Last 1 week`,
`Last 1 month`, `Last 3 months`, `Last 6 months`, `Last 1 year`,
`Last 3 years`. Picking a chip fills the **Time period** inputs
with its start and end.

### Time period

Two `datetime-local` inputs let you specify an explicit start and
end. Editing either input clears the Period chip selection — an
edited range is no longer a quick-select window.

### Apply

Click **Apply** (or press `Enter` while focused in the drawer) to
commit the current draft to the active tab's filter and run the
query. After Apply the drawer closes. Closing the drawer without
Apply (via the close affordance or `Escape`) preserves your
in-flight edits — they reappear the next time you open the drawer.

The drawer rejects a range whose end is not strictly later than its
start, surfacing an inline validation message.

### Save this filter

The **Save this filter** button is present alongside Apply but
disabled in this phase. The naming flow is wired up in a later
Detection phase.
