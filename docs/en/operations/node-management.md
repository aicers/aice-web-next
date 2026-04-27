# Node management

This page documents the **Settings** tab of the Nodes feature. Node and
service status, restart, shutdown, and the per-service configuration
editors are owned by later phases of the same feature and will be
documented as those land.

## Permissions

The Settings tab is reachable only with **both** `nodes:read` and
`services:read`. A custom role missing either receives a 403 redirect.
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

The Edit dialog never writes directly to the manager. Each Save records
a *draft* — a proposed next state — that you can review on the list
page and promote with Apply when ready. Saving a draft requires both
`nodes:write` and `services:write`; built-in **Tenant Administrator**
and **System Administrator** roles already pair the two.

![Save-draft happy path — wireframe](../../assets/node-save-draft-happy-en.svg)

The figure above is an SVG wireframe stand-in. The Edit dialog itself
is built by a sibling Phase Node-9 sub-issue; once that lands, this
figure should be replaced with a real PNG capture from the local
REview procedure documented in `docs/AUTHORING.md`.

### What Save sends

When you click **Save**, the BFF dispatches one
`updateNodeDraft(id, old, new)` call to the manager. The `old` snapshot
is the applied state the dialog opened against; the `new` payload
carries the proposed name, profile, agents, and external-service
drafts. The manager performs a compare-and-swap: if `old` no longer
matches the latest applied state on the server, the call is rejected
as a stale conflict (see below) and your local edits are *not*
silently overwritten.

### What you see in the audit log

Every Save emits one **`service.draft_save`** audit entry per service
whose draft string actually changed in this Save. A Save that touches
two services emits two entries; a Save that only changes node
metadata (name / customer / description / hostname) emits zero
`service.draft_save` entries. Each row carries
`targetId = "${nodeId}:${serviceKind}"` and
`details = { serviceKind, nodeId }`, so operators can filter the audit
log to a single service on a single node.

### Stale-conflict reconciliation

If another writer (a teammate, a script, a parallel browser tab)
saves a draft on the same node between when your dialog opened and
when you click **Save**, the first attempt rejects with a stale
conflict. The BFF transparently re-reads the current node state and
replays your edit once on top of that fresh baseline. You do **not**
see anything during a successful single replay — the Save dialog
simply reports success.

![Stale-conflict reconciliation prompt — wireframe](../../assets/node-save-draft-conflict-en.svg)

The figure above is an SVG wireframe stand-in for the same reason as
the happy-path figure: the Edit dialog UI ships in a sibling Phase
Node-9 sub-issue.

When the replay also conflicts (a third writer landed in between),
the dialog stops and shows a reconciliation prompt:

- **Discard** — drop your unsaved edits and reload the dialog
  against the latest applied state.
- **Re-edit** — keep your edits in the dialog but refresh the
  baseline; you can then review the field-level differences against
  the latest server state and click Save again.

A double-conflicted Save emits **no** `service.draft_save` audit
entry — only successful saves are audited.
