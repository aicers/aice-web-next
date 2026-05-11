# Triage

The Triage page narrows a high-volume detection feed down to the
assets most likely to need a human eye next. For a chosen period,
it reads the per-tenant `baseline_triaged_event` corpus (rows the
cadence job has already scored), composes a bounded menu of the
highest-priority rows via the slot-bucket quota in
[Baseline scoring algorithm](#baseline-scoring-algorithm), and
ranks source addresses by their score contribution from that menu
so an analyst can work the highest-impact rows first. The
detection-event denominator shown in the funnel is counted
separately from `observed_event_meta`.

Viewing the page requires the `triage:read` permission. The
built-in roles Security Monitor, Tenant Administrator, and System
Administrator receive this permission by default. Custom roles
that grant `triage:read` also qualify.

![Triage page (wireframe)](../assets/triage-overview-en.svg)

> **Note:** The figure above is a wireframe stand-in. Live PNG
> captures are produced from a staging tenant once the local-REview
> procedure documented in the [Authoring guide](../AUTHORING.md)
> has a representative Phase 1.B corpus loaded; screenshot rollout
> for both the overview and the pivot panel is tracked under
> [issue #455](https://github.com/aicers/aice-web-next/issues/455)
> and is folded into the read-path measurement gate (see the
> "Read-path measurement" section in PR #525).

## Layout

The page has five regions:

1. **Header** — title, a one-line description of the menu, and a
   **freshness badge** showing how recently the per-tenant baseline
   corpus was last ingested (see [Freshness header](#freshness-header)).
2. **Period picker and mode toggle** — controls for the period
   under analysis and the scoring mode (only **Baseline** is
   wired today).
3. **Funnel** — three numbers for the loaded slice: how many
   events were detected (from `observed_event_meta`), how many
   passed the baseline rule (from `baseline_triaged_event`), and
   the ratio between them.
4. **Asset list and asset detail** — a two-column workspace.
   The list ranks source addresses by total score across the
   caller's customer scope (composite `(customerId, address)` key);
   selecting a row reveals its score, counts, and most recent
   triaged events on the right.
5. **Pivot panel and breadcrumb** — appears below the workspace
   once the operator pivots from the selected asset into a related
   dimension. Shows the pivot trail along the top and the
   **Related events** grouped by dimension (external IP, registrable
   domain, JA3, SNI) below it. Hidden until the first pivot.

## Period picker

The picker takes a start and an end timestamp at minute
granularity (the browser's `datetime-local` control). The
**Apply** button submits the new range; the page reloads with a
fresh slice loaded server-side.

The selector enforces three rules:

- **Maximum lookback: 180 days.** A start timestamp older than
  180 days ago is rejected. The 180-day floor matches the
  `baseline_triaged_event` corpus retention.
- **Maximum duration: 30 days.** A range whose end minus start
  exceeds 30 days is rejected. The 30-day cap is a working-window
  choice (UI cost, percentile-pass cost) rather than a corpus
  property.
- **End after start.** A range whose end is at or before its
  start is rejected.

If a URL is opened with a `start` / `end` query string that falls
outside these rules, the page clamps the values into range and
shows an amber **"Period adjusted to fit the 180-day lookback /
30-day duration cap."** notice above the funnel so the operator
notices that the rendered window differs from what was requested.

The page defaults to a 24-hour window ending at the current time
when no `start` / `end` is supplied.

### Detected denominator and the 30-day retention floor

The funnel's **Detected** number is read from `observed_event_meta`,
whose retention is **30 days** — shorter than the 180-day
`baseline_triaged_event` retention. When the selected window's
earliest moment is older than 30 days ago, the observed denominator
covers only the in-retention slice. The funnel then surfaces a
**"Detected counts cover only the last 30 days."** notice above the
asset list, and per-asset rows whose contribution falls entirely in
the out-of-retention slice get a small `(over last 30d)` suffix on
their detected count so the operator can tell apart "denominator
unknown" from "denominator zero". The asset list's score and
triaged count keep reading from the corpus and remain accurate
across the full window.

## Freshness header

A small badge in the page header reports how recently the per-tenant
baseline corpus was last ingested. The badge reads
`baseline_corpus_state.last_ingested_at` from each tenant DB the
caller has scope to and renders one of six states based on the
combination of `last_run_status` and `last_ingested_at`:

| Status      | `last_ingested_at` | Badge                                  |
|-------------|--------------------|----------------------------------------|
| `ok`        | non-NULL           | "Last updated: N min ago"              |
| `running`   | non-NULL           | "Updating now… (previously N min ago)" |
| `running`   | NULL               | "First ingest in progress…"            |
| `failed`    | non-NULL           | "Last attempt failed N min ago"        |
| `failed`    | NULL               | "First ingest failed"                  |
| (no row)    | —                  | "Awaiting first ingest"                |

When the caller's scope spans multiple tenants the badge picks the
**worst** state across the set (failed > running > no row > ok) so
the operator never sees a green header masking one tenant's failure.
A multi-tenant `ok` reads "Last updated: N min ago, across K
customers"; non-`ok` states list the affected customer ids in the
hover tooltip. The `failed` state surfaces `last_error` on hover
for triage; in a multi-customer scope the tooltip combines the
affected-id list with the error detail (`Affected: 1, 2 — <error>`)
so neither piece of triage context is dropped.

The header intentionally does not surface `baseline_version` or any
other corpus metadata. Audit and debugging use the stored
`baseline_version` column directly.

## Mode toggle

Two modes are visible:

- **Baseline** (active) — the curated rule described
  in [Baseline scoring algorithm](#baseline-scoring-algorithm)
  below.
- **With my policies** (disabled) — the seam for the future
  per-operator policy subtree. The button is rendered so the
  toggle is in place from day one, but it cannot be selected
  until the policy feature ships. Hovering it reveals a tooltip
  saying **"Available once Triage policies ship."**

## Baseline scoring algorithm

Phase 1.B replaces the Phase 1.A whitelist + cluster-bonus formula
with a four-selector cadence-time score and a read-time menu
composition pass. The shape is fixed by
[RFC 0001](https://github.com/aicers/aice-web-next/blob/main/rfcs/0001-baseline-algorithm.md);
the analyst-facing summary below covers what the menu surfaces
without restating the RFC's full formula derivation.

### Cadence-time: `raw_score` and `selector_tags`

When the cadence runner ingests a new event, it computes a
`raw_score` from five within-kind selectors and writes the result
to `baseline_triaged_event.raw_score` together with the
`selector_tags` array that records which selectors fired:

- **S1 — High-confidence.** Within-kind percentile rank of the
  event's confidence against the same `kind`'s 7-day / 14-day /
  30-day history. A 0.92 means "this event sits in the top 8% of
  same-kind events in the active window." Emits `S1-high` when
  the rank exceeds the §9 threshold.
- **S2 — Severe.** Binary signal that flips on when the event's
  `category` belongs to the operator-relevant kill-chain set
  (`COMMAND_AND_CONTROL`, `CREDENTIAL_ACCESS`, `EXFILTRATION`,
  `IMPACT`, `INITIAL_ACCESS`). Emits `S2-severe`.
- **S3 — Recurring.** Saturated count of repeats for the same
  `(orig_addr, resp_addr, kind)` triple in the active window;
  beyond the §9 cap, more repeats do not raise the score. NULL on
  either address yields `s3 = 0`. Emits `S3-recurring` past the
  §9 threshold.
- **S4 — Correlated.** Saturated count of distinct categories the
  same `orig_addr` emits under this kind in the active window —
  measures how broadly the asset is implicated under one kind.
  NULL `orig_addr` yields `s4 = 0`. Emits `S4-correlated` past the
  §9 threshold.
- **`UNLABELED_BONUS`.** Binary signal that flips on for
  `HttpThreat` events whose cluster id is the no-cluster sentinel
  (empty / `none` / `null`). Emits `unlabeled-cluster`.

`raw_score` is the weighted sum of the five selectors (§9 weights);
once written it is immutable within its `baseline_version` so a
later peer event does not retroactively re-rank an already-stored
row.

The cadence drops `BlockList*` events at the very front of the
pipeline before any scoring runs (RFC §1), and the menu read keeps a
defensive `WHERE kind NOT LIKE 'BlockList%'` filter so a regression
on the cadence side cannot leak those rows back into the menu.

### Read-time: `baseline_score` from `cume_dist()`

The menu does not store `baseline_score`. When the menu loads, the
read query computes

```sql
cume_dist() OVER (
    PARTITION BY kind, baseline_version
    ORDER BY raw_score
) AS baseline_score
```

over the rows in the active window. `baseline_score` is therefore
a cohort-relative value in `[0, 1]` — a 0.95 places the event in
the top of its `(kind, baseline_version)` cohort by cumulative
distribution, with the discrete-step / tied-block boundary
semantics PostgreSQL's `cume_dist` provides (a single-row partition
returns `1.0`, so cold-start needs no special handling, and tied
`raw_score` peers receive identical `baseline_score`).

Partitioning by `(kind, baseline_version)` means rows from
different `baseline_version`s are ranked independently — the menu
never compares a `raw_score` from one calibration to a `raw_score`
from another.

### Slot-bucket composition

After `baseline_score` is attached, the menu composes its output
per RFC §4:

- **`slot_bucket`.** Every row maps to a bucket key:
  `('HttpThreat', true)` when the row is an `HttpThreat` carrying
  the `unlabeled-cluster` tag, `(kind, false)` everywhere else.
  Unlabeled HttpThreat thus competes for slots as its own virtual
  kind and a labeled HttpThreat row goes to its own bucket.
- **Per-bucket quota.** Each bucket's share of the menu is
  `base_share + α · normalized_volume · normalized_top_confidence
  + favored_bonus`, where `normalized_top_confidence` is
  `avg(cardinality(selector_tags)) / MAX_TAGS` and `favored_bonus`
  is the §9 constant `β` for the five empirically-useful buckets
  (`DnsCovertChannel`, unlabeled `HttpThreat`, `LockyRansomware`,
  `RepeatedHttpSessions`, `SuspiciousTlsTraffic`). Shares are
  distributed across `default_N` slots via the largest-remainder
  method with a lexicographic `(kind, is_unlabeled)` tie-breaker,
  so the per-bucket quotas always sum to exactly `default_N`.
- **`default_N`.** The cognitive-limit cap on menu size:
  `round(LOWER_FLOOR + scale · log10(1 + post_exclusion_count))`.
  Log10 keeps the menu analyst-readable across activity bands —
  a quiet day still surfaces something, a noisy day does not flood
  the menu.
- **Cutoff + quota.** Within each bucket, rows passing the cutoff
  are sorted by `baseline_score DESC` with the `(event_time DESC,
  event_key DESC)` tie-breaker, and the top `quota[b]` rows
  survive. A bucket's quota applies once across `baseline_version`s
  in the active window — when two versions co-exist, their cohorts
  are merged by `baseline_score DESC` before the cap.
- **`MIN_NONZERO_FLOOR` fallback.** When the slider is strict
  enough that the assembled count falls below the floor (and the
  active window still has at least one post-exclusion row), the
  menu replaces the bucket-composed result with the top
  `MIN_NONZERO_FLOOR` rows globally by `baseline_score DESC`,
  bypassing both quota and cutoff. A clearly-best non-empty menu
  beats a balanced empty menu when the slider can't fill any
  bucket's quota.

The strictness slider that drives the cutoff is owned by a
separate change ([#471](https://github.com/aicers/aice-web-next/issues/471));
until it ships, the menu runs with no additional cutoff above the
cohort, so the visible rows are determined entirely by `default_N`
quota distribution and — when activity is too thin — the
`MIN_NONZERO_FLOOR` fallback.

### `baseline_version` semantics

Every corpus row carries a `baseline_version` string identifying
the algorithm that produced it. Phase 1.A rows carry
`phase1a-simple`; Phase 1.B rows carry `phase1b-four-selector`.
Two implications matter for analysts:

- **Per-cohort ranking is preserved across upgrades.** The menu's
  `cume_dist()` partitions on `(kind, baseline_version)`, so an
  older-version row keeps its relative position within its own
  cohort instead of being silently re-ranked against the new
  scale.
- **Version mix is invisible in the UI.** The header does not
  surface `baseline_version`; natural turnover resolves the
  cross-version mix within the menu's typical 30-day window
  (corpus retention is 180 days, so a long lookback may still
  span more than one version). Audit and debugging read the
  stored `baseline_version` column directly.

A `baseline_version` bump follows any change to:

- the §9 tunables (weights, caps, thresholds, slot-allocation
  constants, `default_N` curve, `MIN_NONZERO_FLOOR`),
- the membership lists (`CRITICAL_CATEGORIES`,
  `FAVORED_BUCKETS`),
- the algorithm's shape (selector addition / removal, scoring
  formula).

Tuning post-merge is therefore a coordinated change — bump the
version constant, redeploy, let the cadence write new-version
rows, and let old-version rows turn over within their retention
window.

## Funnel

The funnel summarises the loaded slice. Sources after the corpus
switch:

| Stat | Source | Meaning |
|---|---|---|
| **Detected** | `observed_event_meta` | Events surviving the cadence's exclusion re-application across the period (clamped lower bound: `max(:from, now() − 30d)` — see [Detected denominator and the 30-day retention floor](#detected-denominator-and-the-30-day-retention-floor)). |
| **Triaged** | `baseline_triaged_event` | Events the baseline rule kept across the full period (180-day retention). |
| **Pass-through** | derived | `Triaged ÷ Detected`, expressed as a percentage. |

The funnel is recomputed on every period change, customer change,
or kind-filter change.

## Asset list

Each row groups events by the composite asset key
**`(customerId, originator IP)`**. Two customers can legitimately
host the same RFC1918 address on different perimeters; the
composite key keeps them distinct end-to-end. Single-customer scope
(the common case) renders identically to a per-tenant view —
`customerId` is just constant across the page. Rows are sorted by
total score (highest first); the first tie-breaker is
`last_event_time` (most recent first). Remaining ties break on
triaged count, then detected count, then address, then customer
id — those are not part of the issue contract but keep the page
deterministic when two rows are tied on both `score` and
`last_event_time`. The sort runs in JavaScript over the
aggregated `TriageAsset` list (`compareAssets` in
`src/lib/triage/aggregate.ts`) after the cross-tenant cap; there
is no per-tenant SQL aggregate SELECT against `baseline_triaged_event`
on the read path.

Events without a usable originator IP — for example, aggregate
threat subtypes that emit a plural `origAddrs` field — still
count toward the funnel's **Detected** total but do not
contribute to any asset row.

The asset list is **derived from the §4 `final_menu_rows`** — the
same set the [Baseline scoring algorithm](#baseline-scoring-algorithm)
composes for the pivot corpus. Each tenant's slice runs one
`cume_dist()` pass over the post-`BlockList*` window and applies the
§4 slot-bucket / largest-remainder / quota composition (and the §6
`MIN_NONZERO_FLOOR` fallback when assembly is below the floor) to
produce per-tenant `final_menu_rows`. Multi-customer scopes issue
one menu-cohort SELECT per customer, merge the per-tenant
`final_menu_rows`, apply the cross-tenant `final_menu_rows` cap in
§3 priority order — `baseline_score DESC, event_time DESC,
event_key DESC` — and then aggregate the visible asset list from
the **surviving capped rows** by grouping on `orig_addr`. Per-asset
score, triaged count, and `last_event_time` reflect only the rows
that survived both the per-tenant menu composition and the
cross-tenant cap: an asset whose menu rows are all evicted by the
cap does not appear on the list, and an asset whose rows are
partially evicted has its score / triaged count / `last_event_time`
recomputed from the surviving slice. An asset cannot rank highly
from rows that did not survive the menu composition — quota,
cutoff, the `MIN_NONZERO_FLOOR` fallback, and the cross-tenant cap
determine the analyst-facing list end-to-end. No `OFFSET` is issued
in the multi-customer code path so the §3 ordering used by the cap
is stable across tenants.

The per-tenant menu-cohort SELECT is a single SQL round-trip — the
`cume_dist()` CTE attaches the §3 `baseline_score`, a `ranked` CTE
adds three window aggregates over the full cohort (`bucket_count`
and `bucket_tag_sum` per `(kind, is_unlabeled)` partition for the
§4 `normalized_volume` / `normalized_top_confidence`, and
`cohort_count` over the entire cohort for `default_N`), and the
outer select returns the top candidates per bucket. The per-bucket
cap is a strict superset of any quota the §6 curve can produce, so
the algorithm composes its output against full-cohort aggregates
even though the row payload is bounded.

Clicking a row populates the **Asset detail** panel on the
right; the first row is preselected when the page loads.

The list shows up to one row per distinct `(customerId, address)`
— a multi-customer scope can legitimately render two rows with the
same private address from different tenants. If no events in the
period pass the baseline rule, the list reads
**"No assets matched the baseline rule in this period."**

## Asset detail

The detail panel for the selected asset shows:

- The asset's source address.
- The asset's **customer name** (the row from `customers.name` for
  the tenant the asset belongs to). Multi-customer scopes commonly
  surface two rows sharing the same RFC1918 address; the customer
  line in the detail header keeps them distinguishable after
  selection.
- **Score**, **Triaged**, and **Detected** counts for the asset.
- The asset's most recent **50 events**, newest first, with each
  event's time, kind (`__typename`), category, and the per-event
  read-time `baseline_score` (the §3 `cume_dist()` value computed
  against the active window's `(kind, baseline_version)` cohort —
  the same partition the menu composition uses, so a detail-panel
  row's score matches the score it would carry in the menu). The
  detail panel for every asset on the list is fetched in a single
  batched SELECT that runs the `cume_dist()` pass once over the
  full cohort and then keeps the newest 50 rows per address — the
  read path never recomputes the window function per asset.

Times are formatted in the session's preferred timezone (set
under **Settings**).

### Field availability in Baseline mode

The Baseline-mode detail panel reads from `baseline_triaged_event`
columns only; subtype-specific fields that are not present on the
corpus row are omitted from the panel. Fields **not** available
in Baseline mode (and the dimensions they would have powered):

- `level` (ThreatLevel) — the level chip and any level filter are
  hidden in Baseline mode.
- `origCountry` / `respCountry` — the **Country** pivot dimension
  is hidden in Baseline mode.
- `origNetwork` / `respNetwork` — the customer-network membership
  classifier falls back to RFC1918 / IPv6 special-use ranges (the
  IP pivot dimensions still work).
- HTTP `userAgent`, DNS `answer`, TLS subtype fields (JA3, JA3S,
  SNI, certificate serial, certificate subject CN), `clusterId` —
  the corresponding **User agent**, **DNS answer**, and **TLS**
  pivot dimensions, plus the **Cluster ID** pivot, are hidden in
  Baseline mode.

These fields all return automatically in the future "With my
policies" mode (corpus B) which retains the full `eventList`
payload through a snapshot JSONB. Inside the Baseline-mode pivot
panel, the dimensions above appear as no-ops because the index
builder skips them when reading from corpus A.

## Hard cap and truncation

The menu read is bounded in two layers:

1. **Per-tenant per-bucket candidate cap.** The §4 menu-cohort
   SELECT returns at most a few hundred candidate rows per
   `slot_bucket` — a strict superset of any quota the §6 curve can
   produce. Full-cohort `bucket_count`, `bucket_tag_sum`, and
   `cohort_count` ride along as window-function columns so the
   algorithm's `normalized_volume`, `normalized_top_confidence`,
   and `default_N` are computed against the active window and not
   the candidate slice.
2. **Cross-tenant `final_menu_rows` cap.** After the per-tenant
   §4 / §6 composition runs, the merged list of `final_menu_rows`
   across the caller's scope is bounded above by **5,000 events**
   before the pivot index is built. The cap is applied in §3
   priority order — `baseline_score DESC, event_time DESC,
   event_key DESC` (numeric-string DESC: `"10"` before `"9"`,
   matching the per-tenant menu composition) — so when a
   multi-tenant scope exceeds the ceiling, the lowest-priority
   rows are dropped first rather than the oldest.
   The visible asset list is then aggregated from the **capped**
   event set, so the asset list and the pivot corpus are derived
   from the same row set: an asset whose menu rows are all evicted
   by the cap does not appear on the asset list, and an asset whose
   rows are partially evicted has its score, triaged-event count,
   and last-event time reflect only the surviving rows. In practice
   the upstream `default_N` cap keeps a single tenant's slice well
   under that ceiling (the §6 curve grows logarithmically with
   cohort size), so this cap is a defense-in-depth safety net
   rather than a routinely-hit limit.

When the cross-tenant cap is hit, the page renders an amber banner
above the funnel:

> Partial: showing 5,000 events of period (truncated at 5,000).

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

> **Note:** The figure above is a wireframe stand-in. Live PNG
> captures are produced from a staging tenant once the local-REview
> procedure documented in the [Authoring guide](../AUTHORING.md) has
> a representative Phase 1.B corpus loaded; screenshot rollout is
> tracked under
> [issue #455](https://github.com/aicers/aice-web-next/issues/455)
> and is folded into the read-path measurement gate (see the
> "Read-path measurement" section in PR #525).

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

Pivoting from a row appends a breadcrumb step. The breadcrumb (asset
focus, every dimension/value pivot step, and the current scope toggle)
is encoded in the URL hash under the `triage.pivot.*` namespace, so a
shared link or browser reload restores the trail against the
freshly-loaded corpus. See [URL hash persistence](#url-hash-persistence)
for the full hash layout and stale-fallback behavior.

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

## Pivot scope toggle (Tier 1 / Tier 2)

A second toggle next to the period picker controls the pivot scope:

- **Triaged only** (default — Tier 1) reads only the events already
  loaded in the corpus. Clicking a dimension never issues a fresh
  fetch, so navigation is instant but the panel can only surface
  matches that pass the baseline rule.
- **All detection events** (Tier 2) keeps the same panel layout but
  switches certain dimensions to a server-side fetch on click. This
  widens the pivot into events outside the baseline slice — useful
  when the loaded corpus is too narrow to show enough context.

The default is **Triaged only** for every fresh menu entry; the
toggle is *not* persisted in account settings. A sticky default
risks an analyst returning to a 5,000-row fetch they did not intend.
Sharing the URL of a Tier 2 view does carry the toggle through —
the breadcrumb and toggle state are encoded in the URL hash so a
shared link is reload-stable.

### Server-filtered Tier 2 dimensions

Toggling to **All detection events** does not issue any fetches by
itself. Round-trips fire only when the operator clicks one of these
dimensions:

- `kinds`, `categories`, `levels` (Tier 2 only — surfaced in a
  separate "Tier 2 only" group that appears once the toggle is on).
  `learningMethods` and `keywords` are also Tier 2-only filter
  fields, but their values are not derivable from the loaded corpus,
  so the panel does not yet surface a click affordance for them.
  Tracked as follow-ups: a static-options group for `learningMethods`
  (issue #498) and a free-form chip input for `keywords` (issue #499).
- `externalIp`, `internalIp`, `country`, `sameSensor` (the same row
  the operator sees in Tier 1, but the click action issues a fresh
  fetch instead of looking up the loaded index).

Other dimensions — JA3, JA3S, SNI, host, URI pattern, certificate
fields, user-agent — are intersected client-side against whatever is
already loaded (the corpus plus every prior Tier 2 result on the
breadcrumb trail), so they remain instant in both modes.

### Fetch progress

Once a Tier 2 fetch fires, a non-blocking progress notice appears
near the panel header naming the dimension and value being fetched.
The notice clears when the fetch resolves (or surfaces as the error
notice when the fetch fails).

### Per-dimension cap and pre-fetch confirmation

A single Tier 2 dimension fetch walks at most **5,000 events**, in
pages of 100 (REview's hard `[0, 100]` cap on `first` / `last`). At
the cap the panel shows a truncation hint similar to the Tier 1
banner. The hint stays visible while any server-filtered Tier 2 step
on the breadcrumb is capped, including after the operator pivots
from a capped ancestor (e.g. `country=KR`) into a client-intersection
descendant (e.g. JA3) whose panel is still computed against that
partial 5,000-row result.

When the projected match count exceeds **20,000 events** (read from
`EventConnection.totalCount`), a confirmation modal blocks the fetch
until the operator approves it:

> **Fetch large result set?** This dimension projects to N events,
> above the 20,000 threshold. The fetch may take a while.

When `totalCount` is unavailable for the filter but the cursor
walk's first page filled, the projection cannot be compared to the
20,000 threshold. The modal opens defensively, surfaces the
first-page lower bound, and is explicit that the total is unknown:

> **Fetch large result set?** Projected size could not be verified
> — the first page returned at least N events, but the total
> against the 20,000 threshold is unknown. Confirming continues the
> fetch up to the per-dimension cap.

Cancelling the modal aborts the fetch; the operator can pick a
different dimension or narrow the period.

### Cache and eviction

Tier 2 results are cached client-side, keyed on
`(periodStart, periodEnd, dimensionId, valueKey, customerScope)`.
Cumulative cache size is capped at **100 MB** of raw event payload
(`JSON.stringify(events).length` summed across dimensions). When an
insertion would exceed the cap, the cache evicts the
least-recently-used dimension result (whole result set, not
individual events) and shows a non-blocking notice naming the
evicted dimension. Re-pivoting on the evicted dimension refetches
from REview.

If a single dimension result is itself larger than the 100 MB cap,
the cache rejects the candidate up front without disturbing other
in-budget entries — the operator sees the same non-blocking notice
naming the rejected dimension, and re-pivoting that dimension
refetches.

The customer scope is part of the cache key so a Tier 2 result for
one customer is never reused after the operator switches to a
different customer in the same browser session.

### Fetch failures

If the BFF cannot complete a Tier 2 fetch (REview timeout, transport
error, or a forbidden response), the page surfaces a dismissible
red notice naming the dimension and value, and the failed pivot is
released so the operator can retry by clicking the row again. The
loaded corpus and the Tier 1 panel are unaffected.

### Weak-signal rendering

A row that came from a Tier 2 fetch and is *not* present in the
Tier 1 corpus (compared via REview's stable per-event `Event.id`)
renders with reduced opacity and a small **weak** badge. Rows that are in
both — including non-baseline `score === 0` corpus members — render
without the badge so the operator can tell at a glance whether a
row was already in the loaded slice or freshly pulled.

### Sensor-pivot limitation

`EventListFilterInput.sensors` requires REview's opaque sensor
**ID**, but Triage events carry only the sensor **name**. The shared
sensor lookup that resolves names to IDs is currently gated on
`detection:read`, which `triage:read`-only operators may not hold.
Until a `triage:read`-compatible lookup ships, Tier 2 sensor pivot
is unavailable; the panel hides the row with a "requires sensor
index" tooltip in Tier 2 mode. The Tier 1 sensor pivot is
unaffected. A shared URL with a `sameSensor` step under
`mode=tier2` is treated as a stale step on restore (the page falls
back to the asset root with a non-blocking notice) so the Tier 1
sensor name is never sent as a literal `sensors: [ID!]` value to
REview.

### URL hash persistence

The asset focus, every dimension step in the breadcrumb, and the
Tier 1 / Tier 2 toggle state are encoded in the URL hash under the
`triage.pivot.*` namespace:

```text
#triage.pivot.asset=42/10.0.0.1&triage.pivot.step=ja3:abc123&triage.pivot.mode=tier2
```

The asset focus is the composite `customerId/address`, so two
customers that share an RFC1918 address remain distinct on restore.
URLs produced before the composite key landed encoded only the
address; the page treats those as stale and falls back to the asset
root with the non-blocking notice rather than guessing which
customer's row to focus.

Loading the page with a populated hash restores the breadcrumb to
that step against the freshly loaded corpus. If a step's value is
no longer reachable in the new period (e.g. a JA3 that no longer
matches any event), the page falls back to the asset root with a
non-blocking notice and clears the stale steps from the breadcrumb.

When the restored hash is in Tier 2 mode and contains a
client-intersection step (e.g. JA3) below a server-filtered
ancestor (e.g. `country=KR`), the page first dispatches the queued
Tier 2 ancestor fetches, then validates the descendant against the
expanded corpus. The descendant is treated as stale only if the
value is still missing once those fetches resolve, so a shared URL
remains reload-stable even when the descendant value lives only in
the ancestor's fetched result.

The hash is namespaced under `triage.pivot.*` so it can coexist
with future Triage hash extensions (e.g. strictness controls under
`triage.strictness.*`) without collision.

## Limitations

- Period start may go back as far as **180 days**; the duration of
  any one window is capped at 30 days.
- The baseline rule is fixed; per-operator policies are not yet
  available.
- The asset key is the composite `(customerId, originator IP)`;
  events that emit plural address fields are not assigned to an
  asset row.
- Up to 5,000 `final_menu_rows` per period are returned across the
  caller's scope; wider periods show a truncation banner.
- The mode toggle, period choices, and per-asset state do not
  persist across sessions. The pivot breadcrumb and Tier 1 / Tier 2
  scope are encoded in the URL hash so a shared / reloaded URL
  restores them, but they reset on every fresh menu entry.
- Tier 2 sensor pivot is hidden until a `triage:read`-compatible
  sensor lookup ships.
- In Baseline mode the **Country**, **User agent**, **TLS** (JA3 /
  JA3S / SNI / cert serial / cert subject CN), **DNS answer**,
  **Cluster ID**, and **Threat level** pivot dimensions are
  hidden — the corresponding columns are not present on
  `baseline_triaged_event`. They return in the future "With my
  policies" mode (corpus B).
