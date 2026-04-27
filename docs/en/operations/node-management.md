# Node management

This page documents the **Status** and **Settings** tabs of the Nodes
feature. The per-service configuration editors and the per-service
on/off control are owned by later phases of the same feature and will
be documented as those land.

## Permissions

Both tabs are reachable only with **both** `nodes:read` and
`services:read`. A custom role missing either receives an HTTP 403
response with the URL preserved; the layout renders a localized
"forbidden" panel instead of the table.
Built-in roles already pair the two:

- **System Administrator** — full read/write/delete across all customers.
- **Tenant Administrator** — full read/write/delete within assigned
  customers.
- **Security Monitor** — read-only within assigned customers; sees the
  list but no Add / Edit / Delete affordances.

## Node list

![Settings · Nodes list](../../assets/node-list-en.png)

The table shows every node the caller has access to. Each row carries
applied state (currently committed on the manager) and any pending draft
side-by-side.

### Pending changes

Rows with a draft that differs from the applied state render with:

- A **Pending** badge on the left edge of the row.
- Two-line cells for any of `name`, `customer`, `description`, or
  `hostname` whose draft value differs from the applied value: the
  applied value appears struck through, with the draft value shown
  below.
- A small amber dot beside any service status icon whose service has a
  pending draft.

The summary chip above the table — "N nodes with pending changes" —
filters the table to changed rows when active.

### Status filter

The chip group above the table accepts any combination of:

- **Pending** — rows whose applied state differs from the saved draft
  for any of name, profile, agents, or external services.
- **Alive** / **Dead** — derived from the one-shot `nodeStatusList` ping
  fetched at page render. The chips are accessibly disabled until the
  ping reading arrives; they switch to live polling data once Phase
  Node-6's polling hook lands.

### Search and sort

The search box matches name, hostname, and customer (case-insensitive)
across both applied and draft values. The sort dropdown re-orders the
visible rows by **Newest**, **Name (A→Z)**, or **Hostname**.

### Tenant filter

System Administrators see an extra **Customer** dropdown that filters by
the assigned tenant. Tenant Administrators are scoped to their
customers automatically and do not see the dropdown.

### Manager column

The right-most column is a status-only badge derived from
`NodeStatus.manager`:

- **Running** — the manager process is reachable on the node.
- **Not running** — the manager has not reported alive.

Manager has no UI-editable draft in v1: no Pending badge and no kebab
appear on the Manager cell.

## Bulk delete

Left-side row checkboxes select one or more rows. Once any row is
selected, a floating bar at the top of the page surfaces:

- "N selected" counter.
- A **Delete selected** action that opens a confirmation modal.
- A **Cancel** action that clears the selection.

Confirming the bulk delete deletes each node individually. Each
successful deletion writes one `node.delete` audit entry with the
node's id and `{ hostname }` in `details`. Failed deletions do not emit
an audit entry.

The checkbox column is hidden entirely for callers without
`nodes:delete` (Security Monitor), so a read-only viewer never sees the
first step of the bulk-delete flow.

## Per-row Edit / Delete

The row kebab menu offers **Edit** (opens the create/edit dialog) and
**Delete** (opens a single-row confirmation modal). Edit and Delete are
hidden for callers without `nodes:write` / `services:write` and
`nodes:delete` respectively.

## Manager offline

When the upstream manager is unreachable, the table area is replaced
with a "Cannot reach manager" panel. The sidebar and the Nodes tab bar
continue to render so the caller can navigate elsewhere.

## Saving drafts

This section documents the **save-draft server action** that lives in
the BFF. The Edit dialog UI that calls into it ships in a sibling
Phase Node-9 sub-issue and is not yet renderable on this branch, so
nothing on this branch lets an operator save a draft from the UI.
What is documented below is the contract the dialog and any other
caller (scripts, automation) will rely on once the dialog ships, and
the audit rows operators will see when saves start landing.

> **Screenshot debt.** The Edit dialog and the stale-conflict
> reconciliation prompt are owned by the sibling sub-issue that builds
> the editing UI. PNG captures of the save happy path and the
> reconciliation prompt will be appended to this section by that
> sub-issue's PR, per `docs/AUTHORING.md`.

### Permissions

The save-draft action requires **both** `nodes:write` and
`services:write`. Calls missing either permission are rejected at the
BFF boundary with a typed `NodePermissionError` before any GraphQL
dispatch reaches the manager. Built-in **Tenant Administrator** and
**System Administrator** roles already pair the two; **Security
Monitor** has neither. Customer scope is enforced by the manager DB
via the dispatch context's `customer_ids`; out-of-scope nodes surface
to the caller as a typed `NodeNotFoundError`.

### CAS contract (`updateNodeDraft(id, old, new)`)

Each save dispatches one `updateNodeDraft(id, old, new)` call to the
manager. The `old` value is the **full node snapshot** the caller
opened against — applied state *and* current drafts (name draft,
profile draft, per-service `status` and `draft`); the `new` value
carries the proposed name, profile, agents, and external-service
drafts. The manager performs a compare-and-swap on that whole
snapshot: if the current server snapshot no longer matches `old` —
including a concurrent draft-only edit by another writer — the call
is rejected as a *stale conflict* and the user's edits are not
silently overwritten.

### `service.draft_save` audit emission

A successful save emits one **`service.draft_save`** audit entry per
service whose draft string actually changed. A save that touches two
services emits two entries; a save that only changes node metadata
(name / customer / description / hostname) emits zero
`service.draft_save` entries. Each entry carries
`targetId = "${nodeId}:${serviceKind}"` and
`details = { serviceKind, nodeId }`, so operators can filter the audit
log to a single service on a single node. Saves that fail at the
permission boundary, the customer-scope check, or with a double
stale-conflict (see below) emit **no** `service.draft_save` rows.

### Stale-conflict replay

When the first `updateNodeDraft` call is rejected with the documented
stale-conflict shape (see `decisions/node-conflict-patterns.md`),
the BFF transparently re-reads the current node, rebases the caller's
intent on top of that fresh baseline, and replays the call once. The
rebase is **field-granular**, not row-granular: if the caller edited
only a service's `draft` and a concurrent writer flipped only that
same service's `status`, the replay sends `{fresh status, user
draft}`. The same per-field merge applies to profile subfields
(`customerId`, `description`, `hostname`). Whole-row fallback applies
only when the caller adds or clears an entry, since there is no fresh
subfield to interpolate against.

If the rebased payload already matches the fresh canonical state
byte-for-byte over the editable surface — the case a redundant retry
of the same payload produces — the replay mutation is **not**
dispatched and no extra audit is emitted.

### `StaleConflictError` on double conflict

When the replay also rejects with the stale-conflict shape, the
server action stops, throws a typed `StaleConflictError`, and emits
no audit. Callers (the Edit dialog and any future automation) are
expected to surface a reconciliation choice to the user — discard the
local edits and reload, or keep the edits and refresh the baseline —
rather than retrying automatically. The visual surface for that
choice is owned by the sibling sub-issue that ships the dialog.

## Status tab

![Status · Nodes status](../../assets/node-status-en.png)

The Status tab is the default landing for `/nodes`. It renders one row
per node the caller has access to, with live resource bars driven by a
client-side polling loop and a node-level control menu.

### Columns

- **Node** — name and hostname, taken from the latest snapshot.
- **CPU**, **Memory**, **Disk** — progress bars. Bars colour amber at
  `≥ 80%` and red at `≥ 95%`.
- **Manager** — derived directly from `NodeStatus.manager` returned by
  `nodeStatusList`. Reads **Running** when `true`, **Not running**
  when `false`.
- Six per-service placeholder columns (Sensor, Data Store, TI Container,
  Unsupervised, Semi-supervised, Time Series) — Phase Node-7 fills
  these with on / off / idle status.
- A row-level kebab opens the **Restart** / **Shutdown** control menu.

### Polling

The table refreshes every `NEXT_PUBLIC_NODE_STATUS_POLL_MS`
milliseconds (default `10000`, clamped to `[5000, 300000]`). When the
tab is hidden, polling pauses; on resume, the hook issues a single
one-shot refresh before the regular cadence resumes. A "Last updated"
indicator above the table reports the timestamp of the most recent
sample, and switches to a "stale" hint when the gap exceeds twice the
polling interval. The hook does not synthesise filler samples — gaps
appear as honest data loss in the rolling buffer.

### Restart / Shutdown

Both actions live behind the row's kebab menu and require
`nodes:write`. Security Monitor accounts see the row but no control
menu. Each action opens a confirmation modal; on confirm, the BFF
calls `nodeReboot(hostname)` or `nodeShutdown(hostname)` and writes a
single `node.restart` / `node.shutdown` audit entry with the hostname
in `details`. Hostname is resolved from the node id server-side, so a
forged hostname cannot bypass tenant scope.

### Row navigation

The Status tab does **not** carry an Apply button. Clicking anywhere
on the row outside the kebab menu navigates to the node's detail
route at `/nodes/[id]`; the node name doubles as a keyboard-focusable
link to the same target. In this release the detail route only
renders a placeholder card — the per-node dashboard with pending-edit
review and the **Apply All Pending** action is delivered by Phase
Node-5 (a follow-up). v1's single apply entry point will live on
that detail dashboard once Phase Node-5 lands; until then no apply
affordance is reachable from the Status tab.

### Manager offline

The Status tab uses the same fallback panel as the Settings tab when
the manager is unreachable. The fallback also kicks in mid-session: if
the manager drops after the first paint, the next polling tick
returns 503 and the table area swaps to the panel rather than
freezing on a stale snapshot. The panel disappears as soon as a
subsequent poll succeeds.
