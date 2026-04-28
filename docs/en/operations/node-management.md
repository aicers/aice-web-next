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

## Bulk apply

This section documents the **bulk-apply executor** that promotes a
node's pending drafts in one operation. The user-facing modal that
opens this flow ships in a sibling Phase Node-9 sub-issue and is not
yet renderable on this branch; what is documented below is the
contract the modal and any other caller will rely on once it ships,
and the audit row operators will see when applies start landing.

> **Screenshot debt.** The Apply preview modal, the lifecycle
> badges, and the retry / rebuild prompts are owned by the sibling
> sub-issue that ships the modal UI. Captures of the apply happy
> path, the partial-failure prompt, and the rebuild-prompt state
> will be appended to this section by that sub-issue's PR per
> `docs/AUTHORING.md`.

### What bulk apply does

Bulk apply runs a two-phase fan-out behind a single user
confirmation:

1. **Manager step.** Dispatches the upstream `applyNode` mutation,
   which atomically promotes every pending draft on the node
   (name, profile, agents, external services) to applied state in
   the manager DB.
2. **External step.** For each external service that had a pending
   `draft` at apply-build time (Giganto for `DATA_STORE`, Tivan for
   `TI_CONTAINER`), dispatches the upstream `updateConfig(old,
   new)` mutation against the service. `old` is read fresh from the
   service on every dispatch (including retries); `new` is the
   frozen draft string captured at apply-build time and never
   re-read.

The dispatches run sequentially in a fixed order: manager first,
then each external in plan order. A failure at any step stops the
fan-out — the next dispatch only runs after the previous one
succeeds.

### Permissions and tenant scope

Bulk apply requires both **`nodes:write`** and **`services:write`**.
The combined gate is enforced at every confirm and every retry
(not just at apply-build time): a caller whose permissions or
customer scope changed between building and confirming the apply
is rejected with a typed `NodePermissionError` before any GraphQL
dispatch reaches the wire.

The recheck is performed at two layers:

1. **Tenant-scope materialisation.** Every confirm and every retry
   rebuilds the dispatch context from the caller's current session,
   re-deriving `customer_ids` (and `customers:access-all` if the
   caller holds it). A caller whose tenant scope resolves to empty
   without `customers:access-all` is rejected before any node is
   read.
2. **Node-specific scope assertion (and existence check).** The
   wrapper then re-reads the canonical node from the manager DB
   **only when the row is in a status that can still reach a
   dispatcher** — `pending` for confirm, `failed_retryable` for
   retry. For terminal / idempotent statuses (`succeeded`,
   `failed_terminal`, `stale`, `expired`, `executing`) the lifecycle
   either returns the persisted row idempotently or rejects without
   dispatching anything, so the canonical-node read is unnecessary
   and would wrongly turn an idempotent re-confirm of an already-
   `succeeded` row into `NodeNotFoundError` once the node is later
   deleted (round 8). Skipping the read for these statuses also
   preserves the audit-recovery finish path: a follow-up confirm /
   retry against a `succeeded` row whose audit emission never
   completed can still drive `node.apply` to durable, even after the
   node has been deleted.

   For tenant-scoped callers, the wrapper re-derives the node's
   `customerId` and asserts it against the caller's *current*
   materialised scope. For globally-scoped callers
   (`customers:access-all`), the wrapper performs the same read but
   only as an **existence check** — there is no tenant boundary to
   enforce, but the read still ensures the node has not been
   deleted between confirm and a subsequent retry. This is critical
   for `retryDispatch` whose target is an external service: the
   external dispatcher otherwise talks to the deployment-global
   Giganto / Tivan endpoints with no per-node guard of its own.
   Without this wrapper-level recheck, an actor whose customer
   scope shrank between confirm and retry could keep driving
   `updateConfig` against an out-of-scope node, and a globally-
   scoped actor could keep driving `updateConfig` against a
   *deleted* node (and emit `node.apply` for it). A forged client
   payload cannot bypass the check because the `customerId` and
   the existence verdict are both read from the manager DB, not
   trusted from the request. For tenant-scoped callers, both
   possible review-web responses for an out-of-scope node — a
   filtered `null` payload *and* a `NOT_FOUND` GraphQL error — are
   mapped to `NodePermissionError` (mirroring the create-attempt
   surface), so the wrapper never leaks "this node exists but you
   cannot see it" semantics back to the caller. For globally-
   scoped callers a deleted-node read surfaces as
   `NodeNotFoundError` (no scope-shrunk semantics to hide).

A bulk apply is **single-actor**: only the account that built the
plan can confirm or retry it. Another account presenting the same
`attemptId` is rejected as `ApplyAttemptNotFoundError` (the BFF
does not leak whether the row exists).

### Lifecycle states

A confirmed apply progresses through one **resumable** state and
three **terminal** states. Only `succeeded`, `failed_terminal`,
and `stale` are terminal — `failed_retryable` is the resumable,
non-terminal state inside the original time window:

- **`failed_retryable`** *(resumable, non-terminal)* — a transient
  external failure stopped the fan-out within the original time
  window. The same actor can call the retry path
  (`retryDispatch({ attemptId, dispatchId })`) to resume from the
  failed dispatch. The frozen `new` from apply-build time is
  replayed; only `old` is re-read fresh. The manager step is
  **not** re-run if it already succeeded. Successive retries
  within the per-dispatch cap drive the row to either `succeeded`
  or `failed_terminal`. The original window is preserved across
  soft fails — a retry submitted past the window surfaces as a
  stale-plan error.
- **`succeeded`** *(terminal)* — all dispatches landed. A single
  `node.apply` audit row is emitted (see below). The row is
  retained for an operator-readable interval and then hard-deleted
  by the cleanup sweep.
- **`failed_terminal`** *(terminal)* — the per-dispatch retry cap
  has been exhausted, the recovery sweep abandoned a stuck claim,
  or the row TTL-terminalised past `expires_at`. The row will not
  transition further; the operator must rebuild the plan from a
  fresh preview. The modal surfaces a "rebuild" prompt for this
  state.
- **`stale`** *(terminal)* — drift between the apply-build and
  apply-confirm fingerprints. Written by the executor when the
  post-claim fingerprint recompute (step 5b) detects the
  mismatch survived; the call rejects with a typed
  `StalePlanError`. No manager mutation is sent and no external
  mutation is sent. A pre-claim hint that drift has settled by
  the time of the post-claim recompute is honored — the
  recompute is authoritative. The modal also surfaces the
  "rebuild" prompt for this state.

### `node.apply` audit emission

A successful apply emits exactly **one** `node.apply` audit row,
regardless of how many calls it took to reach `succeeded` (a
single `confirmApplyAttempt`, a confirm followed by one or more
`retryDispatch` calls, or even an idempotent re-confirm of an
already-`succeeded` row from a double-clicked button). The
"exactly once" contract is enforced by two complementary layers:

**Layer A — schema-level dedupe (authoritative).** `audit_logs`
carries a partial unique index on
`(correlation_id) WHERE action = 'node.apply' AND correlation_id
IS NOT NULL`. Both the wrapper and the cleanup-sweep recovery pass
the attempt UUID as `correlation_id` on every `node.apply` row, so
a duplicate insert from any source — concurrent caller, recovery
sweep, partially-failed prior call, process restart — is rejected
by the database with a `unique_violation` (PG SQLSTATE 23505). This
is the guarantee that no two `node.apply` rows can exist for the
same attempt; it does not depend on coordination between the
wrapper and the cleanup sweep.

**Layer B — slot coordination (avoid the wasted INSERT).** Two
columns on `apply_attempts` serialise the common case so the
duplicate-violation path is the rare exception:

1. `succeeded_audit_emitted_at` — atomically test-and-set
   (`NULL → NOW()`) under a `status='succeeded' AND emitted_at IS
   NULL` guard. Only the caller whose `UPDATE` matches a row may
   emit. Concurrent racers and idempotent re-confirms both observe
   `rowCount = 0` and skip emission.
2. `succeeded_audit_completed_at` — set after the audit row is
   durably written to the audit DB. This makes the emission
   *durable*: once `completed_at` is set, the slot can never be
   released.

If the audit DB write fails synchronously *and* the failure is not
a duplicate-violation, the wrapper releases the slot (clearing
`succeeded_audit_emitted_at` back to `NULL` under a `completed_at
IS NULL` guard) so a follow-up confirm/retry can re-attempt. On a
duplicate-violation the slot is left claimed and `completed_at` is
marked instead — the audit row is already durable, releasing would
just invite the next call to attempt the same insert and get
rejected again. If the process dies between the slot claim and the
audit write, the cleanup sweep's `recoverPendingNodeApplyAudits`
pass picks the row up after the staleness window
(`APPLY_EXECUTING_STALE_MS`) elapses, re-emits the audit using the
row's persisted metadata (`audit_actor` → actor, planned dispatches
→ `appliedServices`, `node_id` → `targetId`, `attempt_id` →
`correlationId`), and marks `completed_at`. If the original audit
row already landed before the crash, the recovery sweep observes
the same duplicate-violation and marks `completed_at` without
re-inserting.

**Cascade-delete and audit recovery (round 8).** Until round 8 the
`apply_attempts.created_by` foreign key on `accounts` was
`ON DELETE CASCADE`, so deleting the creator account would remove
the attempt row out from under the recovery sweep — a row that
reached `succeeded` but never made it through
`succeeded_audit_completed_at` could end up with zero `node.apply`
entries. Round 8 decouples the cascade observable from audit-
recovery durability:

- `audit_actor UUID NOT NULL` is a non-FK snapshot of the creator's
  account id taken at insert time. The recovery sweep reads this
  column for the audit `actor` field, so deleting the account
  cannot strip the actor from a pending recovery.
- The `created_by` FK switches from `ON DELETE CASCADE` to `ON
  DELETE SET NULL`. A `BEFORE DELETE` trigger on `accounts` runs
  first and explicitly deletes `apply_attempts` rows that are NOT
  succeeded-audit-pending, so the umbrella's "cascade-delete
  removes the attempt row" behavior still holds for the common
  case (`failed_retryable`, `pending`, `failed_terminal`, etc.).
  Rows whose `status = 'succeeded' AND
  succeeded_audit_completed_at IS NULL` survive with `created_by`
  set to NULL; the lifecycle's ownership check
  (`row.createdBy !== session.accountId`) then rejects any follow-
  up confirm or retry as `ApplyAttemptNotFoundError` — the
  observable surface a user sees is unchanged — while the recovery
  sweep keeps the row visible and emits `node.apply` using the
  snapshotted `audit_actor`.

**Recovery covers two windows (round 6).** The cleanup sweep's
candidate `SELECT` matches both failure modes:

1. **Slot claimed, completion never landed.** A wrapper claimed the
   slot but the audit insert or `completed_at` marker never landed
   (audit-DB transient or process death after the claim). Predicate:
   `succeeded_audit_emitted_at IS NOT NULL AND
   succeeded_audit_completed_at IS NULL` past the staleness window.
2. **Slot never claimed.** The lifecycle committed `status =
   'succeeded'` but the wrapper crashed before reaching
   `claimNodeApplyAuditSlot`, leaving both audit columns `NULL`.
   Without this branch the row would sit `succeeded` forever with no
   `node.apply` audit; only a manual re-confirm could rescue it.
   Predicate: `succeeded_audit_emitted_at IS NULL` plus a derived
   `succeeded_at` (≈ `expires_at - APPLY_ATTEMPT_RETENTION_MS`)
   older than the staleness window. For this branch the recovery
   sweep claims the slot itself before emitting; if a wrapper
   arrives concurrently and wins the claim, the sweep skips and the
   wrapper drives the row.

**Purge ordering (round 6).** The retention sweep
(`purgeRetained`) hard-deletes terminal rows past their retention
deadline, but it now exempts `succeeded` rows whose
`succeeded_audit_completed_at IS NULL`. This stops a prolonged
audit-DB outage from purging an audit-incomplete row before the
recovery sweep gets a chance to finish it; the row remains
recoverable until `completed_at` is set, then the next purge sweep
removes it. The cleanup orchestrator also runs audit recovery
*before* purge in the same pass, so the audit-DB-healthy case
recovers in a single cycle instead of waiting one cycle for the
exemption to clear.

**Recovery-sweep failure handling.** A transient audit-DB error
during a recovery pass leaves the slot CLAIMED (it does *not* clear
`succeeded_audit_emitted_at` back to `NULL`). Leaving the slot
claimed lets the next sweep re-pick the same row; the staleness
window only grows wider. The same rule applies if the post-insert
`completed_at` UPDATE itself throws: the audit row is already
durable, so the slot stays claimed and the next sweep observes the
schema-level duplicate-violation and marks `completed_at` via the
dedupe path. Together these layers turn the emission contract
from "at most once" into "exactly once per attempt that reaches
`succeeded`".

The audit row carries:

- `actor` — the account that confirmed the apply.
- `action` — `"node.apply"`.
- `target` — `"node"`.
- `targetId` — the node id (not a composite key).
- `details.appliedServices` — the list of external service kinds
  that were dispatched (`["DATA_STORE"]`, `["TI_CONTAINER"]`, or
  both, in plan order).

A confirmed apply that settles to `failed_retryable`,
`failed_terminal`, or `stale` emits **no** `node.apply` row. v1
does not emit a `service.apply` audit per external — that audit is
reserved for Phase Node-12 (#333).

## Apply preview

The **Apply preview** modal is the operator's checkpoint between
saving drafts and confirming the apply. It opens in two phases — a
read-only **planned dispatches** list, and a live **per-dispatch
status** view once the operator clicks **Apply**.

The figures below are wireframe stand-ins per the
infrastructure-gated screenshot exception in `docs/AUTHORING.md`:
the modal does not yet have a mount point on the node detail page
(owned by Phase Node-5 / #311), and the bulk-apply mock manager /
external endpoints used by the e2e harness are tracked separately.
Real PNG captures of all three states will replace these wireframes
in the same PR that lands the detail-page mount.

### Planned dispatches (before execution)

![Apply preview — planned dispatches (wireframe)](../../assets/node-apply-preview-planned-en.svg)

Opening the modal calls `createApplyAttempt({ nodeId })`. The BFF
returns the planned dispatch list — the **top-level dispatches the
BFF itself orchestrates**: the upstream `applyNode` mutation followed
by one `updateConfig` per external service whose draft is pending at
plan-build time. Internal review-web execution stages are not
surfaced; the modal only renders the dispatch sequence the BFF will
issue.

Each row shows the dispatch kind label
(`Manager (applyNode)` / `Data Store (updateConfig)` /
`TI Container (updateConfig)`). The **Apply** button is enabled when
at least one dispatch is planned; an empty plan renders a "no pending
changes" message and disables Apply.

### Per-dispatch status (during and after execution)

Clicking **Apply** calls `confirmApplyAttempt({ attemptId })`. While
the call is in flight the modal:

- Ignores Escape and outside-clicks — the underlying BFF call cannot
  be cancelled, so dismissing the UI mid-flight would orphan the row
  in `executing`.
- Promotes every still-`queued` row to **In flight** so the user can
  see the BFF is currently processing the plan. The settled
  per-dispatch states from the resolved row replace this projection
  on completion.
- Shows the **Applying…** label on the action button.

Each row renders one of five states. **Queued** is shown both before
the user clicks Apply (the planned-list view) and after a settled
`failed_retryable` attempt — under the sequential-advance rule from
#359 a failure halts the sequence with subsequent dispatches still
`queued`, awaiting resume on a successful retry.

| State | Meaning |
| :-- | :-- |
| **Queued** | Not yet started — shown on the planned list before Apply, and on dispatches after a `failed_retryable` row that have not been advanced by the resume rule yet. |
| **In flight** | Dispatch is running (or, while `confirmApplyAttempt` / `retryDispatch` is pending, the modal's projection of "currently being processed by the BFF"). |
| **Succeeded** | Dispatch returned successfully. |
| **Failed (retryable)** | Soft failure; the row offers a **Retry** button. |
| **Failed (terminal)** | Cap exhausted, abandoned, or stale-lock recovery cascade — no Retry. |

State colours are: green for **Succeeded**, sky for **In flight**,
amber for **Failed (retryable)**, red for **Failed (terminal)**, and
muted for **Queued**.

### Retry vs. Rebuild

![Apply preview — failed_retryable with Retry (wireframe)](../../assets/node-apply-preview-retryable-en.svg)

![Apply preview — failed_terminal with Rebuild guidance (wireframe)](../../assets/node-apply-preview-terminal-en.svg)

A failed dispatch presents one of two recovery paths:

- **Retry** — visible only when the dispatch is in
  `failed_retryable`. Clicking the row's Retry button calls
  `retryDispatch({ attemptId, dispatchId })` against the same
  `attemptId`. The state-machine guarantees at most one
  `failed_retryable` per attempt at any time (sequential advance with
  stop-on-first-failure), so the modal never renders more than one
  Retry button on the same plan. On retry success the resume rule in
  `_internal_retryDispatch` advances the next `queued` dispatch
  automatically — no second click is needed.
- **Rebuild** — required when the row settles to `failed_terminal`,
  the plan has gone `stale` / `expired`, or the modal could not even
  fetch a plan. Rebuild discards the current `attemptId` and re-runs
  `createApplyAttempt({ nodeId })` to obtain a fresh plan against the
  latest manager-DB drafts. The modal explicitly tells the operator
  to "Rebuild the preview to apply" when a row is in
  `failed_terminal`; no Retry button is offered on terminal rows.

### Accessibility

The modal carries `role="dialog"` and uses Radix's focus trap so tab
navigation stays within the dialog. Escape closes the modal only
when not executing; per-row Retry buttons carry an accessible name
naming the dispatch kind so screen readers can disambiguate
("Retry – Data Store (updateConfig)").

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
