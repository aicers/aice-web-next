# Triage

The Triage page narrows a high-volume detection feed down to the
assets most likely to need a human eye next. It loads every
detection event for a chosen period, applies a baseline scoring
rule, and ranks source addresses by total score so an analyst can
work the highest-impact rows first.

Viewing the page requires the `triage:read` permission. The
built-in roles Security Monitor, Tenant Administrator, and System
Administrator receive this permission by default. Custom roles
that grant `triage:read` also qualify.

![Triage page (wireframe)](../assets/triage-overview-en.svg)

> **Note:** The figure above is a wireframe stand-in. Phase 1.A
> ships before the live REview screenshot environment is wired up
> for Triage; the wireframe will be replaced with a real PNG
> capture in a follow-up once a representative dataset is
> available against the local-REview procedure documented in the
> [Authoring guide](../AUTHORING.md).

## Layout

The page has four regions:

1. **Header** — title and a one-line description of the current
   phase (Phase 1.A: corpus retention isn't yet available, so the
   period is restricted to the last 30 days).
2. **Period picker and mode toggle** — controls for the period
   under analysis and the scoring mode (only **Baseline** is
   wired today).
3. **Funnel** — three numbers for the loaded slice: how many
   events were detected, how many passed the baseline rule, and
   the ratio between them.
4. **Asset list and asset detail** — a two-column workspace.
   The list ranks source addresses by total score; selecting a row
   reveals its score, counts, and most recent triaged events on
   the right.

## Period picker

The picker takes a start and an end timestamp at minute
granularity (the browser's `datetime-local` control). The
**Apply** button submits the new range; the page reloads with a
fresh slice loaded server-side.

The selector enforces three rules:

- **Maximum lookback: 30 days.** A start timestamp older than
  30 days is rejected. Phase 1.A only supports the last-30-days
  window because corpus retention isn't yet available; when
  retention lands, the lower bound shifts.
- **Maximum duration: 30 days.** A range whose end minus start
  exceeds 30 days is rejected.
- **End after start.** A range whose end is at or before its
  start is rejected.

If a URL is opened with a `start` / `end` query string that falls
outside these rules, the page clamps the values into range and
shows an amber **"Period adjusted to fit the last 30 days."**
notice above the funnel so the operator notices that the rendered
window differs from what was requested.

The page defaults to a 24-hour window ending at the current time
when no `start` / `end` is supplied.

## Mode toggle

Two modes are visible:

- **Baseline** (active) — the curated rule described
  in [Baseline scoring rule](#baseline-scoring-rule) below.
- **With my policies** (disabled) — the seam for the future
  per-operator policy subtree. The button is rendered so the
  toggle is in place from day one, but it cannot be selected
  until the policy feature ships. Hovering it reveals a tooltip
  saying **"Available once Triage policies ship."**

## Baseline scoring rule

The baseline scorer is intentionally narrow:

- **Category whitelist.** An event scores **1.0** when its
  category is one of the operator-relevant kill-chain stages:
  `COMMAND_AND_CONTROL`, `EXFILTRATION`, `IMPACT`,
  `INITIAL_ACCESS`, or `CREDENTIAL_ACCESS`.
- **Cluster bonus.** An `HttpThreat` event whose `clusterId` is
  the no-cluster sentinel (empty, `none`, or `null`, case-
  insensitive) adds another **0.5** on top of the whitelist
  score. These rows correlate with novel HTTP traffic the
  upstream model couldn't bucket and are worth surfacing earlier.

An event whose category is outside the whitelist scores **0** and
is counted in the **Detected** funnel total but not in
**Triaged**, and contributes nothing to its asset's score.

There are no exclusions, no per-operator policies, and no
persistence in Phase 1.A.

## Funnel

The funnel summarises the loaded slice:

| Stat | Meaning |
|---|---|
| **Detected** | Total events loaded for the period (after the 5,000-event hard cap, see [Hard cap and truncation](#hard-cap-and-truncation)). |
| **Triaged** | Events whose baseline score is greater than zero. |
| **Pass-through** | `Triaged ÷ Detected`, expressed as a percentage. |

## Asset list

Each row groups events by the originator IP address (`origAddr`).
Rows are sorted by total score (highest first); ties break on
triaged count, then detected count, then address.

Events without a usable originator IP — for example, aggregate
threat subtypes that emit a plural `origAddrs` field — still
count toward the funnel's **Detected** total but do not
contribute to any asset row.

Clicking a row populates the **Asset detail** panel on the
right; the first row is preselected when the page loads.

The list shows up to one row per distinct address. If no events
in the period pass the baseline rule, the list reads
**"No assets matched the baseline rule in this period."**

## Asset detail

The detail panel for the selected asset shows:

- The asset's source address.
- **Score**, **Triaged**, and **Detected** counts for the asset.
- The asset's most recent **50 events**, newest first, with each
  event's time, kind (`__typename`), category, and per-event
  baseline score.

Times are formatted in the session's preferred timezone (set
under **Settings**).

## Hard cap and truncation

Triage paginates `eventList` cursor-by-cursor until either every
event in the period is loaded or **5,000 events** have been
collected, whichever comes first. The 5,000-event cap is a
demo-stage safety net so a wide period over a noisy day cannot
silently load tens of thousands of rows.

When the cap is hit while REview still reports more rows, the
page renders an amber banner above the funnel:

> Partial: showing 5,000 events of period (truncated at 5,000).

If the cap is reached on the final page (i.e., REview reports no
further rows), the banner does not appear — the operator did see
every event in the period.

To work a wider period without the truncation banner, narrow the
range with the period picker and apply again.

## Error states

If the BFF cannot fetch events for the chosen period, the page
renders the empty shell with one of these banners:

- **"Could not load events for this period. Try a different
  range."** — the BFF reached REview but the response was an
  unrecognised error.
- **"You are not authorized to view triage results."** — the
  caller lacks `triage:read`. (In practice this is unreachable
  because the page-level permission check redirects first; the
  banner exists as defense in depth.)
- **"You have no customers in scope. Contact an
  administrator."** — the caller holds `triage:read` but no
  customers are assigned to their account.

## Related events panel and pivot

When an asset is selected, the page also renders a **Related events**
panel below the asset list. The panel groups other events from the
loaded corpus by pivot dimension so the operator can see what else
the focused asset has in common with the rest of the slice — without
issuing any additional network requests.

![Pivot panel (wireframe)](../assets/triage-pivot-en.svg)

> **Note:** The figure above is a wireframe stand-in. Phase 1.A
> ships before the live REview screenshot environment is wired up
> for Triage; the wireframe will be replaced with a real PNG capture
> as part of the EN/KR Triage manual screenshot pass tracked by
> [issue #455](https://github.com/aicers/aice-web-next/issues/455).

### Pivot dimensions

The panel surfaces events grouped by:

- **Network** — external IP, internal IP, destination port, country.
  External vs internal is decided by the same per-side classifier
  used elsewhere in Triage (customer-defined network membership wins;
  RFC1918 / IPv6 special-use ranges are the fallback).
- **Application** — registrable domain (Public Suffix List), host
  header, URI pattern, user-agent. The URI is normalized to a
  pattern: query and fragment stripped; numeric segments templated
  to `{id}`, canonical UUIDs to `{uuid}`, long pure-hex segments to
  `{hex}`. So `/api/v1/users/42?token=…` and
  `/api/v1/users/99?token=…` collapse into the same pivot value
  `/api/v1/users/{id}`.
- **TLS** — JA3, JA3S, SNI (server name), certificate serial,
  certificate subject CN.
- **DNS** — DNS query, DNS answer (multi-answer rows are split, and
  only IPv4 / IPv6 literal tokens are kept; CNAMEs and status text
  such as `NXDOMAIN` that REview sometimes surfaces in the same
  field are filtered out so the dimension stays a "DNS answer IP"
  pivot, not a generic "answer string").
- **Time / structure** — same kind within ±15 minutes (events of
  the same `__typename` whose timestamp falls within fifteen
  minutes of the focused event's timestamp on either side), same
  sensor, cluster ID. Earlier revisions used a fixed 30-minute
  bucket and could call neighbors that were two minutes apart a
  miss when they straddled a bucket boundary; the dimension now
  resolves the window relative to the focus event itself.

Dimensions where the focused asset carries no value, or where the
loaded corpus has no other matching events, are hidden — never shown
empty.

### Per-section behavior

Each section ranks its rows by per-event score, descending; ties
break newest-first. The default view shows up to **10 rows** per
section. A **Show more** affordance expands to **50 rows**. Once the
section is expanded and the underlying match set is larger than the
50 rows on screen, a `Showing 50 of N` hint appears alongside the
**Show less** affordance. The hint is suppressed while the section
is collapsed (the visible row count is 10, not 50, so a "Showing 50"
hint there would contradict what is on screen) and when the expanded
view fits the entire match set.

The events that drive the focus (i.e., the events whose origAddr is
the asset's address, or that share the breadcrumb's pivot value) are
not listed in their own related-events rows — the panel surfaces the
*other* events that share a dimension with them.

When the period banner reads
`Partial: showing N events of period (truncated at 5,000)`, the
panel surfaces the same hint at its top so a missing match is not
read as confirmed absence.

### Breadcrumb (multi-step pivot)

Pivoting from a row appends a breadcrumb step. The breadcrumb is
local to the current view — it is not persisted in the URL.

- The first crumb is the asset (e.g., `Asset 10.0.0.1`).
- Each subsequent crumb names the dimension and value pivoted to
  (e.g., `JA3: 7e29c8…b4`). Clicking an earlier crumb restores the
  view to that step. Clicking the asset crumb collapses every
  dimension step back to the asset focus.

When a dimension crumb is the active step, the asset-detail card
relabels itself as **Pivot focus** and renders the events that
share the pivoted-to value rather than the originally-selected
asset's stats. The asset list keeps the original asset highlighted
so the operator can backtrack by clicking the asset crumb or
re-selecting from the list.

A new asset selection from the asset list resets the breadcrumb to
that asset; it does not append.

### Period change confirmation

When the breadcrumb has at least one dimension step, applying a new
period surfaces a confirmation modal:

> **Discard pivot trail?** Changing the period will reload the
> corpus and clear your current pivot trail. Continue?

Confirming reloads with the new period and clears the trail.
Cancelling keeps the existing period.

## Limitations in Phase 1.A

- Only the last 30 days are loadable.
- The baseline rule is fixed; per-operator policies are not yet
  available.
- The asset key is a single originator IP; events that emit
  plural address fields are not assigned to an asset row.
- Up to 5,000 events per period are aggregated; wider periods
  show a truncation banner.
- The page does not persist period choices, mode selection,
  breadcrumb state, or any per-asset state.
- Pivot is read-only over the loaded corpus. Expansion into events
  outside the loaded slice (Tier 2) is tracked separately and is
  not part of Tier 1.
