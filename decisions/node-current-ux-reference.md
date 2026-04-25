# Node & service management — current aice-web UX reference

This document captures the **current aice-web UI** as a functional baseline that aice-web-next must match in scope. It is a reference for the implementation, **not a strict visual spec**. Where the current UX can be improved, aice-web-next should improve it; the improvement directions agreed for v1 are listed at the end.

Screenshots in `./assets/node/` (numbered `01.png`–`24.png`) correspond to the sections below.

## Entry structure

The Node area sits under **운영 관리 / 노드** (Operation Management / Node) in the left sidebar. Two tabs cover the baseline this document describes:

- **Status** (상태) — default landing view, monitoring + apply
- **Settings** (설정) — node CRUD + per-service config draft review

## Status tab (screenshots 01–03)

One row per node. Columns:

- Node name
- CPU usage (%)
- Used memory / Total memory
- Used disk / Total disk
- Six service cells — **Sensor, Data Store, TI Container, Unsupervised Engine, Semi-supervised Engine, Time Series Generator**. Each cell shows an orb (🟢 on / ⚪ off) with a "켜짐/꺼짐" label and a `⋮` kebab menu for per-service on/off (screenshot 02).
- **Control** cell — default label "재부팅" (reboot) with a `⋮` kebab menu that offers **Reboot / Shutdown** (screenshot 03).
- **Apply** button on the far right. Enabled when any part of the node's draft differs from the applied state. Internally fans out to `applyNode`, and when external services (Giganto, Tivan) have draft changes, also calls their `updateConfig` directly.
  - **v1 correction**: aice-web-next moves this apply entry point **off** the Status row. In v1 the single Apply affordance is "Apply All Pending" on the node detail-page dashboard — the Status tab is read-only with respect to apply (see umbrella `#306` Scope and sub-issue `#312`).

Manager is **not** represented as a column today. aice-web-next will add it (see improvements).

Resource values are **polled** (no subscriptions). In aice-web-next, polling should pause when the tab is backgrounded.

## Settings tab (screenshots 04–05, 09)

Node list table. Columns:

- Selection checkbox
- **Name**, **Customer**, **Description**, **Hostname** — each cell shows two lines: `설정: X / 임시저장본: Y` (applied / draft).
- Six service cells — each shows `설정: 설정 보기 / 임시저장본: 임시저장본 보기` links that open a read-only popup. Unsupervised Engine shows `설정: 수동 설정 / 임시저장본: 수동 설정` because it is always in "Configure Manually" mode.
- Top-right: sort dropdown (`ㄱ → ㅎ (이름)`) and **+ 추가** (Add) button.
- When rows are checked, a bulk-action bar appears at the top with `× N 선택됨` and a trash icon (screenshot 05).
- Each row has a `⋮` menu on the right offering **Edit / Delete** (screenshot 09).

## Service config view / draft detail popups (screenshots 06–08)

Clicking **설정 보기** (View Config) or **임시저장본 보기** (View Draft) opens a read-only popup with labeled fields. Config and draft render in separate popups — users must open both and compare by eye. No diff view.

Screenshot 06–07: Sensor applied vs draft.
Screenshot 08: Data Store applied vs draft (first applied, second draft).

## Add / edit node dialog (screenshots 10–23)

A single scrollable modal containing node metadata + per-service sections. The user scrolls vertically through the whole form.

### Node metadata (screenshot 10)

- **Name** `*`
- **Customer** `*` (dropdown — scoped to customers the logged-in user has access to)
- **Description** (optional)
- **Hostname** `*`
- Checkbox list to toggle services on/off (screenshot 11): Sensor, Data Store, TI Container, Unsupervised Engine, Semi-supervised Engine, Time Series Generator. Manager is implicit; not listed.

### Per-service sections

When a service's top-level checkbox is checked, its configuration block expands with a **tree-indented layout** using drawn lines (`└→`, `→`) to signal parent/child relationships.

Agent-type services (Sensor, Semi-supervised Engine, Time Series Generator) show a **"여기서 설정하기 / 직접 설정하기" radio** first. Selecting "직접 설정하기" disables the inputs below. External-type services (Data Store, TI Container) do not have this radio.

The exact fields, validation rules, and preset values are documented in `node-field-catalog.md`.

- **Sensor** (screenshots 12–15) — Data Store connection (IP / hostname / port 38370), PCI Bus Addresses, per-protocol port config (Standard + Custom Ports with a `+ 다른 조건 추가` button for multiple ports), Dump Items, Max PCAP Size.
- **Data Store** (screenshots 16–17) — Receive / Send / Web addresses and an **Advanced Options** collapsible with retention, RocksDB tuning, etc.
- **TI Container** (screenshot 18, top) — Web address only (port 8444).
- **Unsupervised Engine** (screenshot 18, middle) — checkbox only; no configuration fields.
- **Semi-supervised Engine** (screenshots 18 bottom, 19–22) — Data Store connection, Protocols, Models (a long checkbox list that grows with every detection model added), Sensors (checkbox list of currently registered sensor nodes).
- **Time Series Generator** (screenshot 23) — Data Store connection with Receive Port (38370) and Send Port (38371).

Buttons: **취소 / 저장** (Cancel / Save) fixed at the bottom-right of the modal.

## Data lifecycle the current UI exposes

1. Saving the Add/Edit dialog writes to **draft** only (via `updateNodeDraft` on edit, `insertNode` on add).
2. Actual application to the running service happens on the **Status tab Apply button**. The button fans out internally to `applyNode` (agent drafts go via manager DB promotion + agent notify-pull) plus direct `updateConfig` calls to Data Store and TI Container when those drafts differ. Users do not see this fan-out. — **v1 correction**: aice-web-next moves this apply entry point to the detail-page dashboard's Apply All Pending affordance; the Status row holds no Apply button.
3. Reading the applied config of an external service would go through that service's own `config` GraphQL — in the current UI this distinction is hidden.

## Gaps between current UI and the authoritative spec

The authoritative spec is `./node-and-service-mgmt.md`. Where the current UI diverges:

- Manager service has no column in Status and no card in Settings. The spec requires both.
- Per-service "apply" is not exposed — Apply is only at node level.
- Unsupervised Engine is hardcoded as "Configure Manually" in the UI, matching the spec's concept that this service has no UI-editable config.
- There is no node detail page — just list + per-row modal.
- Side-by-side diff between applied config and draft does not exist.
- Node restart/shutdown exist; per-service on/off does not (server-side mutation absent).

## UX directions for aice-web-next v1

These are the decisions that inform sub-issue acceptance criteria. They represent intent, not final visual designs.

### Information architecture

- **Sidebar placement changes.** The baseline path `운영 관리 / 노드` is **not** carried over in v1. aice-web-next exposes Node management at a **top-level sidebar entry labelled Nodes (EN) / 노드 (KR)**, not nested under an "Operation Management" group. This matches the flat Detection / Dashboard / Accounts sibling layout and is fixed at the umbrella level (`#306` Sidebar placement decision).
- **Keep the Status / Settings split as sibling routes** — `/nodes` is Status (default), `/nodes/settings` is the list.
- **Introduce a node detail page** reached by clicking a row in either tab. The detail page is the place where all of that node's state, services, and configuration live side-by-side. The single Apply entry point (Apply All Pending) lives here on the dashboard header.
- **Add a Manager column** in the Status tab and a Manager card on the detail page.

### List (Settings tab)

- Show cells as a single value (applied) when there is no pending change. Show two lines + a **"Pending" badge on the left edge of the row** only when the draft differs. Removes repetitive noise for unchanged rows.
- Add a top summary chip "N nodes with pending changes" that filters the table to changed rows when clicked.
- Add a search box (name / hostname / customer) next to the sort/add controls. Add a status filter (alive / dead / pending) once the status-monitoring sub-issue ships.
- Keep the kebab-per-row Edit / Delete and the bulk-select trash bar — both patterns are already familiar from the current UI.

### Create / edit dialog

- **Keep a single modal with per-service sections.** Do not split into a wizard or left-nav layout — the grouping is shallow enough that one scroll view with clear section headings works better than navigation overhead.
- Use a **collapsible section per service** (radix Accordion). Checking the top-level service checkbox expands its section; unchecking collapses it. Gives users orientation without losing tree semantics.
- Replace the tree-indented line art with plain indentation + section borders. Visual complexity goes down.
- Cap visible nesting at **two levels deep**. Sub-patterns like Sensor's "protocol → standard/custom ports" become a **chip / tag input** (`21 (standard) 2121 2222`) instead of a separate checkbox + list per protocol.
- Add **inline validation**: hostname format, IP format, port range, required fields, name uniqueness. All client-side where possible; server-discovered conflicts (e.g. unique clashes) map back to the offending field with an inline error, not a toast.
- Render the **"Configure Here / Configure Manually" choice as a switch** in the service section header, with an informative description card when Manually is selected ("This service reads its configuration from a local TOML file on the node; aice-web-next cannot inspect or edit it"). This replaces the current radio + greyed form.
- Keep the Giganto **Advanced Options collapsible** (already present today).
- Surface **retention** as a numeric input + unit selector (days / weeks / months), not a bare number with an implicit day unit.

### Status tab + detail page

- Render resource usage as **progress bars with threshold colouring** instead of raw `used / total` text.
- On the detail page, show a **time-series chart per resource** (CPU / memory / disk). The rolling window holds up to 60 samples at the polling cadence driven by `NEXT_PUBLIC_NODE_STATUS_POLL_MS` (default 10 s → ~10-minute window). The label is **derived from sample timestamps** ("last N samples · ~M minutes"), not a fixed wall-clock string. The buffer lives client-side in the Phase Node-6 polling hook; charts on the detail page are consumers, not owners.
- **Visibility pause and gap rendering.** When the tab is hidden, polling stops; v1 has no backend-side history or backfill, so missed samples are not reconstructed when the tab returns. On resume, the hook fires an **immediate one-shot refresh** before the next polling tick. If the gap between the new sample and the previous one exceeds `2 × pollInterval`, the new sample is flagged as a **segment boundary** and the chart line **breaks visually at that point** — no interpolation, no dashed bridge across the pause. The latest sample is treated as **stale** when older than `2 × pollInterval`; the chart label appends "· data stale", the trailing line stroke and final point render in a muted colour, and the progress bar's numeric label appends the `lastSampleAt` time.
- Individual service on/off toggles are **not part of v1**. The mutation is not yet specified upstream (see `#317`); no affordance is rendered in v1. When Phase Node-8 activates after review-web lands the mutation, the intended UX is optimistic updates (immediate local flip, spinner overlay, rollback toast on failure) — but nothing ships in this release.
- Service cards on the detail page do **not** carry a per-service Apply button in v1. The single apply affordance is node-level Apply All Pending on the dashboard header; per-service Apply arrives uniformly across every service kind with Phase Node-12 (#333) after review-web's applyNode split.
- **Apply preview dialog**: clicking Apply All Pending opens a preview modal listing the BFF's planned top-level dispatches in order ("① update node applied state via `applyNode`, ② push Giganto config via `updateConfig`, ③ push Tivan config via `updateConfig`"). After execution it shows per-dispatch success/failure. The preview does not attempt to expose review-web's internal stages — `applyNode` does not surface them to callers.

### Draft vs applied comparison

- Replace the two-popup "View Config / View Draft" flow with **a single panel that has three tabs**: *Applied*, *Draft*, *Diff*. The Diff tab lists only changed fields with `before → after` rendering. Fields that have no change are collapsed or marked "unchanged".

### Status polling and stability

- Client-side polling interval is configured by the `NEXT_PUBLIC_NODE_STATUS_POLL_MS` environment variable (default 10 000 ms, clamped to `[5 000, 300 000]`). Migrating this to a `system_settings`-backed key with per-role read access is a deferred follow-up (see umbrella Out of scope), not part of this feature.
- Pause polling when `document.visibilityState === "hidden"`; on resume issue an **immediate one-shot refresh** (do not wait for the next polling tick), then resume the regular interval cadence.
- v1 has **no backend-side history or backfill** for resource samples. A pause longer than `2 × pollInterval` produces a **visible gap** in the time-series chart (line break at the segment boundary) and a **stale visual** on the latest point until fresh data arrives. The buffer continues to retain older samples; only the line connection across the gap is suppressed. Backend-backed history is its own future effort, separate from this UX feature.
- No GraphQL subscriptions in v1 — polling is simpler and the current backend does not expose subscriptions for this surface.
