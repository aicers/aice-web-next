# Detection

The Detection page is accessed from the sidebar. It is the hub for
investigating detection results produced by the backend — filtering,
reviewing, and drilling into individual findings.

Viewing the page requires the `detection:read` permission. The
built-in roles Security Monitor, Tenant Administrator, and System
Administrator receive this permission by default. Custom roles that
grant `detection:read` also qualify.

![Detection page](../assets/detection-en.png)

## Layout

The page is organized into four regions. The Results area is the
dominant region of the workspace; the supporting regions are kept
compact so they do not distract from the findings.

### Saved / Recommended rail

A slim rail on the left lists two sections:

- **Recommended Filter** — curated starting points.
- **Saved Filters** — filters you have saved yourself.

On narrow viewports the rail collapses to icons only. On desktop
widths it expands to show the section headings.

### Top bar

The top of the main region holds the **Filters** button and the
active filter chip bar. Clicking **Filters** opens the filter
drawer on the right; the chip bar to its right summarises the
filter currently applied to the active tab.

### Results

The Results region fills most of the screen and displays the
detection findings. On page entry the default filter
(**Last 1 hour**) runs automatically so the page is never empty on
first view. A full result list renders in a later phase; for now
the region shows a single line summarising how many events match.

### Analytics strip

Below Results, an Analytics strip is reserved for aggregate views of
the current result set. It is collapsed by default; clicking the `▸`
affordance reveals an empty placeholder panel in this phase.

## Filter drawer

The filter drawer is where you describe the window of detection
events you want to look at. It opens from the **Filters** button
in the top bar and slides in from the right.

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

### Direction

The **Direction** section is a three-way multi-select matching the
backend's `FlowKind` values:

- `Inside → Outside` (outbound traffic)
- `Inside → Inside` (internal traffic)
- `Outside → Inside` (inbound traffic)

All three are selected by default, which is equivalent to "no
filter" — the submitted filter omits `directions` in that case.
Toggle a chip off to drop that direction from the results. The
drawer refuses to empty the set: attempting to deselect the last
remaining direction silently reverts to all three selected, since
an empty selection would mean "no rows".

When fewer than three are selected, the active filter chip bar
renders one chip per selected direction (e.g. `Direction: Inbound`,
`Direction: Internal`).

### Apply

Click **Apply** (or press `Enter` while focused in the drawer) to
commit the current draft to the active tab's filter and run the
query. After Apply the drawer closes. Closing the drawer without
Apply (via the close affordance or `Escape`) preserves your
in-flight edits — they reappear the next time you open the drawer.

The drawer rejects a range whose end is not strictly later than its
start, surfacing an inline validation message.

### Network / IP

The **Network / IP** section carries a summary line and a funnel
affordance. Activating the funnel opens the advanced Network/IP
filter panel alongside the drawer so the drawer stays in view.

![Network/IP advanced filter](../assets/detection-endpoint-filter-en.png)

The panel has two sections:

- **Saved Network/IPs** renders in v1 but is not functional. It
  shows `No saved network/IPs` and a help line explaining that
  saved network/IP groups are not yet available in this version.
- **Custom Network/IPs** is fully functional. Each row represents
  a single entry with its original text, a selection checkbox, a
  Direction selector (Both / Source / Destination) and a remove
  control.

A single text input above the list accepts three formats:

- Single IP — `10.84.1.7`.
- IP range — `10.1.1.1 - 10.1.1.20`.
- CIDR network — `192.168.10.0/24`.

Press `Enter` or the `+` button to commit the entry. A smart
parser routes each entry into the correct bucket — single IPs
become hosts, ranges become ranges, CIDRs become networks. An
invalid input surfaces an inline error listing the three valid
examples.

Above the list, a master checkbox selects or clears every entry
and a `Set directions` control applies a direction to all selected
rows at once. Deselected rows are visually de-emphasized but
retain their state; they are simply omitted when the filter is
submitted.

Close the panel with the close affordance or `Escape`. The
entries you've added persist until you close the filter drawer
without applying.

#### Active filter chips

Each committed Network/IP entry surfaces a chip in the active
filter bar so the operator can see what's scoped:

- No entries — no chip.
- 1–3 entries — one chip per entry, each prefixed with `Src`,
  `Dst`, or no prefix for Both (e.g. `Src 10.0.0.5`).
- More than 3 entries — a single aggregate chip
  (`Network: N rules`) that, when activated, re-opens the advanced
  panel with the Custom section expanded.

### Save this filter

The **Save this filter** button is present alongside Apply but
disabled in this phase. The naming flow is wired up in a later
Detection phase.
