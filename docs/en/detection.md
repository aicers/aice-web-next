# Detection

The Detection page is accessed from the sidebar. It is the hub for
investigating detection results produced by the backend — filtering,
reviewing, and drilling into individual findings.

Viewing the page requires the `detection:read` permission. The
built-in roles Security Monitor, Tenant Administrator, and System
Administrator receive this permission by default. Custom roles that
grant `detection:read` also qualify.

![Detection page — wireframe stand-in](../assets/detection-en.svg)

!!! note "Wireframe stand-in"

    The page-level illustration above is an SVG wireframe rather than a
    real capture. The Detection page renders its hero count from a live
    REview query, and the authoring worktree has no staging backend with
    seeded detection data — a PNG captured here would show the
    `Could not load detection results.` error state. Per
    `docs/AUTHORING.md`'s "Screenshot exception for
    infrastructure-gated features", this page ships a localized SVG
    wireframe and will be replaced with a real screenshot once a
    staging environment with sample data is available. The filter
    drawer capture further down is a real PNG — the drawer is
    client-rendered and does not depend on backend data.

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

The chip bar follows an aggregation rule so it stays compact when
many values are active:

- The committed period / time range renders as a single
  `Period: <range>` chip anchored to the left of the bar. The chip
  body reopens the drawer on the time-range section. Its `×`
  clears the active time window — the list then runs without a
  time constraint until you pick a new period or range in the
  drawer.
- Single-value fields (`Source`, `Destination`) render as a single
  chip with the value (e.g. `Source: 10.0.0.5`).
- Tag fields with **1–3** values render one chip per value.
- Tag fields with **more than 3** values collapse to a single
  count token (e.g. `Keywords: 12`). Activating the count chip
  reopens the drawer so you can edit the list.

Every active filter dimension that has a simple URL representation
round-trips through the address bar, so refreshing the page, sharing
the link, or returning from Investigation restores the same filtered
tab. That includes `Source` / `Destination`, tag fields
(`keywords`, `hostnames`, `userIds`, `userNames`,
`userDepartments`), `Kinds` (single- or multi-select), `Level`,
`Country`, `Category`, `Learning method`, `Direction`,
`Confidence`, `Sensor`, and any custom time range (`start=` /
`end=` when no `1d` / `7d` shorthand applies). The one filter
dimension that does **not** round-trip today is the Network/IP
Advanced rows; a reload drops those rules and reloads only the
URL-representable subset.

### Results

The Results region fills most of the screen and displays the
detection findings. On page entry the default filter
(**Last 1 hour**) runs automatically so the page is never empty on
first view.

The header above the list shows `Detected Events <range> / <total>`
(BigInt-safe so very large counts render verbatim) plus an
**Updated** relative-time indicator and a **Refresh** affordance
that re-runs the current query. A **Download CSV** affordance is
rendered but disabled in this phase ("CSV export arrives in a
later phase").

Each event renders as a compact two-line entry:

- **Line 1** — severity badge (`LOW` / `MEDIUM` / `HIGH`,
  color and label) · time · friendly kind name (e.g.
  `HTTP Threat`) ·
  optional `Attack: …` secondary label for the four ML subtypes
  (`ExtraThreat`, `HttpThreat`, `NetworkThreat`,
  `WindowsThreat`) · category (where set) · confidence (two
  decimals) · triage summary (`⊙ N policies · MAX max`) when
  the event carries any policy scores.
- **Line 2** — `source endpoint → destination endpoint` (IP,
  port, country short name) · sensor. Address-array fields
  (`origAddrs`, `respAddrs`, `respPorts`) collapse to a `+N more`
  popover that lists every hidden value formatted the same way.
  Each entry inside the popover exposes its IP as a pivot link,
  so the overflow addresses — the only place
  `MultiHostPortScan`, `RdpBruteForce`, and
  `UnusualDestinationPattern` surface their extra IPs — can be
  pivoted on, not just the first IP shown in the row.

The destination endpoint and severity badge stay visible at every
supported viewport width — the responsive strategy is density,
not column drop. At narrow widths source and destination stack
vertically inside the row; secondary labels — including the ML
`Attack: …` sub-label and the category name — collapse away, and
country decorations abbreviate, while IPs, ports, severity, time,
and kind remain readable.

Clicking anywhere on a row body opens the **Quick peek** panel
(see below) with the event summary header. A dedicated affordance
on the right of each row jumps directly to the full Investigation
view; events with no addressing data hide that affordance because
no locator can be built for them.

Several subtypes cannot render the full `source IP:port →
destination IP:port` pair because the REview schema itself does
not expose the missing fields. The list degrades gracefully per
subtype rather than dropping the row, but the operator should
expect the following gaps:

- **`ExtraThreat` and `WindowsThreat`** — host-based process /
  pattern events (user, process, image) with no originator or
  responder address at all. Both endpoints render `—`, the
  Investigation jump is suppressed, and Quick peek mirrors the
  empty endpoint state; everything else on the row (severity,
  time, kind, attack kind, confidence, triage, sensor) is
  unchanged.
- **`ExternalDdos`** — exposes IPs and countries on both sides
  but no ports. The row renders `origAddr → respAddr` with no
  `:port` suffix on either cell.
- **`FtpBruteForce` and `LdapBruteForce`** — no originator port.
  The source cell renders the IP and country without a port
  suffix; the destination cell keeps its port.
- **`RdpBruteForce`** — no responder port (and no originator
  port). The destination cell renders the IP and country without
  a port suffix.
- **`UnusualDestinationPattern`** — no originator at all. The
  source cell renders `—`, the destination cell renders the
  responder IPs and countries (no port), and the Investigation
  jump is suppressed because the locator token requires an
  originator.

Pivotable values inside a row render as inline links rather than
plain text, so clicking them navigates to a narrowed Detection
view instead of opening Quick peek. In this phase the kind label
and each endpoint's IP are wired as pivot links (same-kind last
7 days, same-source-IP / same-destination-IP last 24 hours). The
pivot URL params fold into the structured filter on arrival:
`kind` becomes a `Kinds` filter and `window` sets the time range,
so the chip bar shows `Kind: HTTP Threat` and `Period: Last 7 days`
against a query that actually narrowed to those values — not
decorative chips attached to the default 1 h range. The same URL
shape round-trips back out on every dispatch (Refresh, chip
removal, Apply) and, in addition to the pivot subset, covers the
other filter dimensions you edit in-session (level, country,
category, learning method, direction, confidence, sensor,
multi-kind, and custom time ranges), so reload, share, and the
Investigation back-link return you to the same filtered tab you
left. The "no time filter" state — when you remove the **Period**
chip — round-trips through the URL as `time=none`, so reload,
share, and the Investigation back-link return you to the same
no-time tab instead of silently re-introducing `Last 1 hour` from
the default-period fallback. Network/IP Advanced rules are the
exception — those stay in memory and are dropped on reload. The full pivotable surface
defined in Phase Detection-12 — level, category, country,
direction, hostname, user ID / name / department — will follow
once that phase widens the pivot URL model.

#### Loading / empty / error states

- **Before the first query lands** the header shows the bare
  fallback label and the body shows a loading line. A spinning
  Refresh icon mirrors the in-flight state.
- **Before any filter has been applied** — e.g. a future `+` tab
  that mounts without the first-tab auto-execute — the body shows
  a **"Build a filter to see events"** prompt instead of the
  zero-results copy, so the operator is never told "no matches"
  when the reality is simply that no query has run yet.
- **Zero matches** — the header still shows
  `Detected Events 0-0 / 0` (zero-result is information; the count
  is not hidden) and the body shows a clear "No matches" copy
  block.
- **Query failed** — the body switches to an error message; the
  Refresh affordance stays enabled so the operator can retry.

### Quick peek inspector

Clicking a row opens the Quick peek panel — a summary surface
that confirms which event was clicked and offers a one-click
jump into the full Investigation view. Per-tab detail panes
(Protocol / Payload / Related Events) arrive in a later phase;
the header (severity / time / kind / sensor) and the
Investigation jump are wired today.

The inspector layout adapts to the viewport:

- **Desktop (≥ 1280 px)** — the inspector docks inline as a
  right-side pane and the result list shrinks proportionally to
  share the horizontal space.
- **Narrow widths** — the inspector opens as an overlay sheet so
  the result list keeps its full width.

### Removing chips

Each chip in the active filter chip bar carries an `×` affordance.
Pressing `×` is a self-contained commit: the field (or the
specific value) is removed from the active filter, the query
re-runs immediately, and the chip disappears — no Apply round-trip
through the drawer is required. Aggregate chips' `×` clears the
whole field; per-value chips clear just that value. Activating a
chip body (rather than the `×`) opens the filter drawer focused on
the matching control.

#### Forward compatibility — query mode

A future search-language mode is reserved for Phase Detection-2's
`Filter` discriminated union (`mode: "query"`). When that mode
ships the chip bar will render the query text as a single
editable pill rather than attempting per-field decomposition, so
the `OR` / `NOT` / regex constructs the structured chips cannot
represent stay coherent. The current code path implements only
the `structured` branch.

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

Leaving both inputs empty is also a valid committed state: **Apply**
accepts a fully-cleared range and the list runs without a time
constraint until you pick a new period or type a new range. The
drawer only rejects an *asymmetric* pair (one side filled while the
other is blank) or an inverted range (end ≤ start).

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

### Confidence

The **Confidence** section narrows the result set to events whose
detection score falls within a `[min, max]` window. The domain is
`0.00`–`1.00` with two-decimal precision; arrow keys nudge the
focused input by `0.01`, `Home` jumps to the input's lower bound
(`0.00` for min, the current min for max), and `End` jumps to the
corresponding upper bound.

The inputs cannot produce a reversed range — typing a min that
exceeds the current max snaps max upward, and vice versa. Leaving
both inputs at `0.00` / `1.00` is the "no filter" default and
omits `confidenceMin` / `confidenceMax` from the submitted query.
Any non-default range surfaces a single chip in the active filter
bar (for example, `Confidence 0.70 – 1.00`).

### Customer

**Customer** is a disabled placeholder marked **Coming soon**.
Customer scoping still happens automatically — results are already
limited to the customers your account has access to — but picking
a subset of them from the UI arrives with the Customer directory
in a later phase. The field is never submitted with the filter and
never appears in the chip bar.

### Sensor

**Sensor** is a multi-select backed by the sensor inventory that
the detection backend maintains for the customers you can access.
Open the control to reveal a search box, a **Select all / Clear
selection** toggle, and a scrollable list of sensors; picked
sensors also appear as removable chips just below the control.

Applying the filter submits the selected sensor IDs; they show up
in the active chip bar at the top of the page. For one to three
selections each sensor gets its own chip; four or more collapse to
a single `Sensor: N selected` aggregate token so the bar does not
wrap unpredictably.

If the detection backend in use has not yet published the
sensor-list endpoint, the Sensor control falls back to the same
**Coming soon** disabled state as Customer and is simply not
submitted. This fallback only appears in transitional builds — as
soon as the backend ships the endpoint the control becomes
functional without any further change here.

While the sensor list is being fetched on the first drawer open,
the control shows a **Loading sensors…** affordance instead of
**Coming soon** so the disabled state is not mistaken for a
missing endpoint. If the fetch fails transiently, the control
surfaces a **Could not load sensors** message with an inline
**Retry** button; clicking Retry re-issues the request without
having to close and reopen the drawer.

### Source, destination, and user attributes

Below the sensor control, a dedicated **Attributes** section narrows
the query by free-form strings.

- **Source** and **Destination** are single-value text inputs — the
  active filter carries exactly one source string and one destination
  string at a time. Validation is lenient: the backend rejects
  malformed values, so operators can paste whatever REview accepts.
- **Keywords**, **Hostnames**, **User IDs**, **User Names**, and
  **User Departments** are tag inputs. Press `Enter` or type a comma
  to commit the current entry as a chip; `Backspace` on an empty
  input removes the most recent tag. Paste a comma-separated or
  newline-separated list to bulk-add many values at once. Entries
  are trimmed and deduped automatically.

Clearing all tags in a field omits that field from the submitted
filter entirely. Apply also mirrors the free-form fields into the
URL so a refresh restores the active tab's filter state.

### Categorical filters

Below the time range, a **Categorical filters** section groups the
per-event dimensions you can narrow by. Each dimension is a
multi-select with the same interaction pattern:

- A trigger shows the current summary. For closed-list fields
  (Threat Level, Threat Country, AI Model Type, Threat Category)
  the summary reads `All` when everything or nothing is selected —
  both mean "no filter" — and `N selected` otherwise. **Threat
  Name** is treated as an open list while its options are still a
  seed subset (see below): a saturated Threat Name selection reads
  as `N selected` rather than `All`, because the submitted filter
  still actively constrains to the visible list.
- An **All** master toggle selects or clears every option. When
  some but not all options are checked, the toggle renders as a
  mixed state.
- Long lists (Threat Country, Threat Category, Threat Name) expose
  a case-insensitive substring search above the options.
- For closed-list fields, selecting zero options and selecting
  every option are both treated as "no filter" — the field is
  omitted from the submitted query and does not appear in the chip
  bar. Threat Name follows a different rule: selecting zero still
  omits the field, but selecting every visible option submits the
  explicit list and still emits chips, since the seed list is not
  exhaustive.

![Detection filter drawer — categorical filters wireframe](../assets/detection-drawer-categorical-en.svg)

The figure above is an SVG wireframe stand-in for the expanded
categorical section. It is shipped under `docs/AUTHORING.md`
§"Screenshot exception for infrastructure-gated features"; replace
it with a PNG capture (`detection-drawer-categorical-en.png`) once
a staging environment with a seeded REview session is available to
render all five fields in their expanded state.

The five categorical fields are:

- **Threat Level** — `Low` / `Medium` / `High` (maps to
  `levels: [1, 2, 3]` on the backend).
- **Threat Country** — originator / responder country, selected by
  ISO-3166 alpha-2 code. The list includes the REview sentinels
  `XX` and `ZZ` so events that could not be geolocated can still
  be filtered in or out. These surface with explicit localized
  labels — `Location unknown (XX)` and `Location database
  unavailable (ZZ)` — and the option search matches both the raw
  code and the meaning (e.g. searching `unknown` lands on `XX`,
  `unavailable` lands on `ZZ`).
- **AI Model Type** — `Unsupervised` / `Semi-supervised` (maps to
  `learningMethods`).
- **Threat Category** — the 14 MITRE ATT&CK tactic-style categories
  REview tags events with (Reconnaissance, Initial Access,
  Execution, …).
- **Threat Name** — a curated starting list of attack kinds
  submitted as REview's canonical event `__typename` tokens
  (`HttpThreat`, `PortScan`, …). The option labels render the
  friendlier display name ("HTTP Threat", "Port Scan"), and search
  matches either form. The list is an open seed subset rather than
  an exhaustive option source: saturating the visible list does
  **not** broaden the query, and a live completion sourced from
  REview will replace the seed list in a follow-up.

### Active filter chip bar

Applied filters appear as chips in the top bar next to the
**Filters** button. Categorical fields follow a shared aggregation
rule:

- For closed-list fields: no chip when nothing or everything is
  selected for a field (both mean "no filter").
- For Threat Name (open-list): no chip when nothing is selected,
  but a saturated selection still emits chips because the field is
  still actively filtering to the visible list.
- One chip per value for 1 – 3 selected values.
- A single aggregate token (e.g. `Countries: 12 selected`) when
  more than 3 values are selected, to keep the bar compact.

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
