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

Pending state is comparison-based: a row, service, or external is
pending iff the saved draft differs from the applied state — for
agents, `agent.draft != agent.config`; for externals, the manager-side
`draft` is compared structurally to the external endpoint's live
`config` fetched at page load. A draft that round-trips the applied
value reads as steady state and renders no pending indicator.

Rows whose comparison flags any drift render with:

- A **Pending** badge on the left edge of the row.
- Two-line cells for any of `name`, `customer`, `description`, or
  `hostname` whose draft value differs from the applied value: the
  applied value appears struck through, with the draft value shown
  below.
- A small amber dot beside any service status icon whose service is
  pending.
- A small slate **unknown** dot beside an external-service status icon
  when the page-load read of Giganto / Tivan failed for that kind. The
  pending state cannot be answered against an unreachable endpoint, so
  the row shows the unknown indicator instead of silently rendering as
  "no pending changes".

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

## Creating and editing a node

The **Add** button on the Settings list opens the create/edit dialog;
the **Edit** option in the per-row kebab menu opens the same dialog
pre-populated with the canonical node payload. Both surfaces require
**both** `nodes:write` and `services:write`. A caller missing either
permission does not see the **Add** button and is rejected with HTTP
403 if they navigate directly to the edit URL.

![Create node dialog with Sensor enabled](../../assets/node-create-en.png)

### Node metadata

The top of the dialog collects the four metadata fields documented in
`decisions/node-field-catalog.md`:

- **Name** — required, max 32 characters, unique across nodes. The
  uniqueness pre-check runs against the list currently visible; the
  manager confirms on save and the dialog scrolls back to the field
  on conflict.
- **Customer** — required, single-select. Tenant Administrators see
  only the customers their account is assigned to; System
  Administrators see every customer.
- **Description** — optional, max 64 characters.
- **Hostname** — required, max 64 characters, lowercase
  `[a-z0-9-.]` only, no leading/trailing `.` / `-`, no consecutive
  specials.

Inline errors appear under each field as the user types; a
server-reported conflict scrolls back to the field with the upstream
message inline.

### Service accordion

Below the metadata block, every service has a collapsible section.
The header carries:

- A **checkbox** that enables or disables the service's membership on
  this node — i.e., whether the node hosts the service at all. This
  is a configuration decision, distinct from the per-service runtime
  on/off control that Phase Node-8 will introduce.
- For Sensor, Semi-supervised Engine, and Time Series Generator: a
  **Configure here / Manually** switch. When set to **Manually**,
  the panel collapses into an informative card —
  *"This service reads its configuration from a local TOML file on
  the node; aice-web-next cannot inspect or edit it."* — and the
  draft sent to the manager is an empty string. **Unsupervised
  Engine** always shows the informative card; it has no switch.

### Cancel and Save

Clicking **Cancel** discards every edit and emits no audit entries —
toggling the configuration mode and then cancelling does **not**
produce a `service.set_mode` row. Clicking **Save** runs form-wide
validation and, only on full pass, dispatches the create / update
mutation through the BFF.

A successful create emits exactly one `node.create` audit row. A
successful edit emits one `node.update` row **only** when at least
one of `name`, `customer`, `description`, or `hostname` changed; an
edit that touches only service drafts emits zero `node.update` rows
(the per-service `service.draft_save` rows from Phase Node-9 are
emitted instead). When the user toggled an agent service's
**Configure here / Manually** switch and the save succeeded, one
`service.set_mode` row is emitted per net-changed service.

### Server-conflict mapping

REview's GraphQL surface returns plain-text error messages for
uniqueness and scope conflicts. The BFF matches each message against
the pattern table in `decisions/node-conflict-patterns.md` and routes
the typed error to the correct field:

- **Name uniqueness** → inline under the Name field.
- **Hostname uniqueness** → inline under the Hostname field.
- **Customer scope / not found** → inline under the Customer field.
- **Stale conflict on update** → the dialog renders a dedicated
  reconciliation prompt with **Discard my edits and reload** and
  **Keep editing** actions, separate from the generic footer banner.
  The Phase Node-9 server action drives the underlying single-shot
  replay; the prompt only appears when that replay also conflicts
  (see *Saving drafts* below). Both actions hit `GET /api/nodes/[id]`
  to refresh the canonical baseline before continuing — **Discard**
  re-seeds the form against the freshly-fetched node (the user's
  in-flight edits are dropped); **Keep editing** preserves edits the
  user made but rebases untouched node-metadata fields onto the
  refreshed baseline, so the next save reflects the current server
  state for fields the user did not change instead of overwriting
  them with the pre-refresh value. The baseline is also refreshed
  so the next save's `old` payload matches the current server
  state instead of re-tripping the same CAS check. The dialog
  stays open in both cases, and Save is disabled while the
  refresh is in flight.
- **Agent not found** → the BFF maps the upstream `agent <key> not
  found` message back to the service registry kind via
  `serviceKindFromAgentNotFound` and the dialog pins the inline error
  inside that accordion section. If the identifier does not match a
  known agent, the message falls through to the form-level banner.

Unmatched messages surface as a single form-level banner above the
footer.

## Saving drafts

This section documents the **save-draft server action** that lives in
the BFF. The Edit dialog UI from the section above is the primary
caller; the contract documented here also applies to scripts and
automation.

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

### Edit dialog — save happy path and stale-conflict prompt

The Edit dialog discharges the screenshot debt deferred by Phase
Node-9b (PR #366). The save happy-path capture below shows the
post-save state outcome: the dialog has closed, the Settings list
is restored, and the `node.update` / `service.draft_save` audit
entries the section above describes have been emitted by the BFF.
The capture is taken after the dialog unmounts on a successful
save rather than during the in-flight edit, so the asset reflects
"the save succeeded" rather than "the save is about to be
attempted":

![Edit dialog save happy path](../../assets/node-save-happy-en.png)

The stale-conflict reconciliation prompt — surfaced when the BFF's
single-shot replay also hits the CAS check — captured under the
mocked-GraphQL path documented in `docs/AUTHORING.md`:

![Stale-conflict reconciliation prompt](../../assets/node-stale-conflict-en.png)

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

Bulk apply runs a three-phase fan-out behind a single user
confirmation:

1. **Manager DB step.** Dispatches the upstream `applyNodeDraft`
   mutation, which atomically promotes every pending draft on the
   node (name, profile, agents, external services) to applied state
   in the manager DB. An agent or external service whose `draft` is
   `null` (operator delete intent) is **removed** from the node by
   this step.
2. **Manager notify step.** Dispatches the upstream
   `applyAgentConfig` mutation, which notifies every agent on the
   node whose post-promotion `config` is `Some(non-empty)` so the
   agent re-pulls the new config. If the node's `hostname` is empty
   the mutation rejects the call and the dispatch is marked
   `failed_terminal` immediately (no retry will succeed until the
   operator edits the profile).
3. **External step.** For each external service that had a pending
   non-null `draft` at apply-build time (Giganto for `DATA_STORE`,
   Tivan for `TI_CONTAINER`), dispatches the upstream
   `updateConfig(old, new)` mutation against the service. `old` is
   read fresh from the service on every dispatch (including
   retries); `new` is the frozen draft string captured at
   apply-build time and never re-read.

The DB stage runs first and gates everything that follows — if it
fails, no notify or external dispatch is attempted. **On DB
success, the notify dispatch and every external `updateConfig`
dispatch run in parallel.** Each post-DB dispatch holds its own
per-dispatch claim and commits its own state independently: a
notify failure does not delay the externals, a single external's
failure does not delay the others, and a slow dispatch does not
block faster siblings from completing. The row's aggregate status
(`succeeded` / `failed_retryable` / `failed_terminal`) is committed
only after every post-DB dispatch has finalised, computed from the
per-dispatch outcomes. The two manager-side dispatches are
independently observable and retryable: an operator-driven retry
of the notify dispatch on a row whose DB stage has already
succeeded does not re-run the DB mutation.

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

### Planned dispatches (before execution)

![Apply preview — planned dispatches](../../assets/node-apply-preview-planned-en.png)

Opening the modal calls `createApplyAttempt({ nodeId })`. The BFF
returns the planned dispatch list — the **top-level dispatches the
BFF itself orchestrates**: the upstream `applyNodeDraft` mutation,
the upstream `applyAgentConfig` mutation, then one `updateConfig`
per external service whose draft is pending at plan-build time.
Internal review-web execution stages are not surfaced; the modal
only renders the dispatch sequence the BFF will issue.

Each row shows the dispatch kind label
(`Manager DB (applyNodeDraft)` /
`Manager notify (applyAgentConfig)` /
`Data Store (updateConfig)` / `TI Container (updateConfig)`). The
**Apply** button is enabled when at least one dispatch is planned;
an empty plan renders a "no pending
changes" message and disables Apply.

### Per-dispatch status (during and after execution)

Clicking **Apply** calls `confirmApplyAttempt({ attemptId })`. The
BFF call is one-shot — it does not stream per-dispatch progress
back to the client. While the call is in flight the modal:

- Ignores Escape and outside-clicks — the underlying BFF call cannot
  be cancelled, so dismissing the UI mid-flight would orphan the row
  in `executing`.
- Optimistically projects the first queued row (the **Manager DB**
  dispatch) to **In flight** to signal that the apply is running.
  Later rows stay **Queued** in the modal view while the call is
  pending; the modal cannot mirror the BFF's DB-success handoff or
  the parallel post-DB fan-out because that transition is not
  streamed.
- Shows the **Applying…** label on the action button.

Once `confirmApplyAttempt` resolves, the modal renders the final
per-dispatch states returned by the BFF — every post-DB dispatch
will already be settled at that point (`succeeded`,
`failed_retryable`, or `failed_terminal`) because the executor
runs the post-DB fan-out to completion before returning. Operators
see the final per-row outcome; intermediate "DB succeeded, post-DB
running" states are not visible in the modal.

Each row renders one of five states. **Queued** is shown before the
user clicks Apply (the planned-list view) and, in the modal's
optimistic projection, on every non-DB row while
`confirmApplyAttempt` is still pending.

| State | Meaning |
| :-- | :-- |
| **Queued** | Not yet started — shown on the planned list before Apply and on non-DB rows while `confirmApplyAttempt` is pending. |
| **In flight** | Dispatch is running. While `confirmApplyAttempt` is pending the modal projects this state on the **Manager DB** row only (the BFF's DB-success / parallel post-DB transition is not streamed back to the client). While `retryDispatch` is pending it projects this state on the retried row only. |
| **Succeeded** | Dispatch returned successfully. |
| **Failed (retryable)** | Soft failure; the row offers a **Retry** button. |
| **Failed (terminal)** | Cap exhausted, abandoned, or stale-lock recovery cascade — no Retry. |

State colours are: green for **Succeeded**, sky for **In flight**,
amber for **Failed (retryable)**, red for **Failed (terminal)**, and
muted for **Queued**.

### Retry vs. Rebuild

![Apply preview — failed_retryable with Retry](../../assets/node-apply-preview-retryable-en.png)

![Apply preview — failed_terminal with Rebuild guidance](../../assets/node-apply-preview-terminal-en.png)

A failed dispatch presents one of two recovery paths:

- **Retry** — visible only when the dispatch is in
  `failed_retryable`. Clicking the row's Retry button calls
  `retryDispatch({ attemptId, dispatchId })` against the same
  `attemptId`. Because the post-DB fan-out runs every notify and
  external dispatch in parallel under its own claim, a single attempt
  can settle with more than one `failed_retryable` dispatch on the
  same row; the modal renders an independent Retry button per failed
  row. A retry re-runs **only** the targeted dispatch — sibling
  states (including other `failed_retryable` rows) are preserved
  exactly as observed.
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

## Node detail page

The detail page renders at `/nodes/<id>` and is reached by clicking a
node row from the Status tab (the read-only entry point) or by
following a deep link from another surface that names a node id. The
page combines the node's metadata, live ping and resource indicators,
and a per-service card grid with the same Apply preview modal
documented above.

### Dashboard

![Node detail dashboard](../../assets/node-detail-en.png)

The dashboard at the top of the page lays out the node's metadata
(name, hostname, customer, description, last applied at), a **ping
indicator** (alive / dead with a "Last seen ..." timestamp), and three
resource sparklines (CPU, memory, disk) driven by the same client-side
polling loop as the Status tab. The sparklines carry one SSR-seeded
sample on first paint so the chart does not render an empty axis on
cold loads, and the polling buffer takes over from the next client
tick onward. A **Pending changes** badge appears whenever any
node-level draft differs from its applied state (name / profile /
agent / external service, comparison-based). When the only pending
signal is an external whose page-load endpoint read failed, the
dashboard renders a **Pending state unknown** badge instead and
disables the **Apply All** button with a tooltip explaining the
state — Apply must wait until the external responds. The dashboard's
controls (`Edit`, `Restart`, `Shutdown`, `Apply All`, `Delete`) are
individually gated on the relevant write / delete permissions.

### Service cards and three-tab panel

![Node detail service card](../../assets/node-detail-services-en.png)

Below the dashboard, the page renders a card grid with one card per
service the node hosts (Manager, Sensor, Unsupervised Engine,
Semi-supervised Engine, Time Series Generator, Data Store, TI
Container). The Manager card is status-only — it surfaces a live
running / not-running badge and no configuration tabs. Every other
card carries:

- A status badge (`On` / `Off` / `Idle`) driven by the same shared
  polling buffer as the Status tab.
- A **Pending changes** badge (amber) whenever the comparison rule
  flags the service: agents compare `draft` against `config`;
  externals compare the manager-side `draft` against the endpoint's
  live `config` from the page-load snapshot.
- A **Pending state unknown** badge (slate) on an external card when
  the page-load endpoint read failed for that kind. The applied tab
  cannot be rendered in that case, and the per-card pending state
  cannot be answered.
- A three-tab panel: **Applied** (the live config the service is
  running with), **Draft** (any pending operator-authored changes),
  and **Diff** (a per-field diff between Applied and Draft).
- An **Edit this service** link (gated on `nodes:write + services:write`)
  that deep-links into the create/edit dialog with the relevant
  service section auto-expanded.

The Diff tab is rendered cell-by-cell from the comparison rule:

- **Steady state** (`draft == config` for agents, `manager.draft ==
  endpoint.config` for externals) renders the documented copy
  `"No pending changes for this service."`.
- **Change intent** (`draft` is non-null and structurally differs)
  renders the per-field Applied / Draft diff table.
- **Delete intent** (`draft = null` while applied is non-null) renders
  the delete marker `"This service is marked for removal on the next
  Apply."` above the diff table — the operator sees exactly which
  applied fields the Apply will tear down.

When the external service (Data Store / TI Container) is unreachable,
the Applied tab renders the unavailable copy and the Diff tab renders
`"Diff cannot be computed while the service is unreachable."` — the
Draft tab continues to render normally because the draft is held on
the manager side, not on the external endpoint.

### Apply preview from the detail page

![Apply preview — mid-execution](../../assets/node-apply-preview-mid-en.png)

The dashboard's **Apply All** button opens a confirmation prompt that,
once accepted, mounts the same Apply preview modal documented in
*Apply preview* above. The mid-execution capture above shows the modal
during the executing phase — the manager dispatch is in flight, the
**Applying…** label is on the action button, and Escape / outside-
clicks are disabled until the call resolves. From here the modal
proceeds to the per-dispatch status view (`Succeeded`, `Failed
(retryable)` with a Retry button, or `Failed (terminal)` with the
Rebuild guidance) as documented above.

### Manager offline fallback

When the canonical-node read fails with a manager outage after the
combined gate has already passed, the page swaps to the same
manager-unavailable fallback panel as the Status tab. This is the
post-gate "manager dropped before this read" path; it is not the same
surface as the gate-time HTTP 403 a caller without `nodes:read +
services:read` would see.

### Permissions on the detail page

The detail page is gated on `nodes:read + services:read`. A
**Security Monitor** (read-only) reaches the page and sees the
dashboard, status indicators, and service cards (read-only) — but
does not see Edit, Delete, Restart, Shutdown, Apply All, or any
per-service "Edit this service" affordance. Because **Apply All**
is the only entry point to the Apply preview modal on this page, a
Security Monitor never reaches it. The per-service on/off control
documented for Phase Node-7 ships with #317 PR 2 and is not
present on this page in v1.

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
- Six per-service columns (Sensor, Data Store, TI Container,
  Unsupervised, Semi-supervised, Time Series) — each cell renders an
  **on / off / idle** badge derived from the service's signal. See
  [Status legend](#status-legend) below for the per-type rules.
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
link to the same target. The detail route surfaces the per-node
service-status cards described in [Status legend](#status-legend) —
one card per service (Sensor, Unsupervised, Semi-supervised, Time
Series, Data Store, TI Container) with the on / off / idle badge,
diagnostic tooltip, and a per-card "Last checked Xs ago" footer that
ticks with the relevant signal (the per-node poll for agent cards,
each external probe for its own card). The per-node dashboard with
pending-edit review and the **Apply All Pending** action is delivered
by Phase Node-5 (a follow-up); v1's single apply entry point will
live on that detail dashboard once Phase Node-5 lands. Until then no
apply affordance is reachable from the Status tab.

### Status legend

Each per-service cell renders one of three states. The state vocabulary
is shared across the Status tab and the per-node detail-page service
cards.

| State | Visual | Meaning |
|-------|--------|---------|
| **On** | green dot | Service is enabled and reporting healthy. |
| **Off** | grey dot | Service is disabled, unreachable, or the node is dead. |
| **Idle** | amber dot | Agent has reported a transient failure (currently `RELOAD_FAILED`). External services do not use this state in v1. |

Per-type signal rules:

- **Agent services** (Sensor, Unsupervised, Semi-supervised, Time
  Series) read directly from `NodeStatus.agents[].storedStatus`:

    | `storedStatus` | Cell |
    |----------------|------|
    | `ENABLED` | On |
    | `DISABLED` | Off |
    | `UNKNOWN` | Off |
    | `RELOAD_FAILED` | Idle |

- **External services** (Data Store, TI Container) dispatch the
  service's own `status` GraphQL query each polling cycle. A
  successful response renders **On**; any error — connection refused,
  HTTP 500, GraphQL `errors[]`, schema mismatch — renders **Off**.
  External services have no Idle state in v1. Probes are staggered so
  Giganto and Tivan are not hit on the same tick; the per-service
  cadence defaults to `NEXT_PUBLIC_NODE_STATUS_POLL_MS`.

- **Dead-node override** — when the node's `ping` is `null` (the node
  has not answered the manager's most recent ping), every per-service
  cell collapses to **Off** regardless of the raw signal. The Manager
  badge has its own ping signal and is unaffected.

- **Tooltip** — hover over a cell to see the raw underlying signal
  ("Agent reports Disabled", "External service unreachable", "Node has
  not responded; service status forced off") for diagnosis without
  opening the detail page.

The Manager badge in the same row is owned separately by Phase Node-6
and is *not* part of the per-service vocabulary above. It is derived
directly from `NodeStatus.manager: Boolean!` returned by
`nodeStatusList`.

![Status row with the Sensor agent in Idle state](../../assets/node-status-legend-en.png)

### Manager offline

The Status tab uses the same fallback panel as the Settings tab when
the manager is unreachable. The fallback also kicks in mid-session: if
the manager drops after the first paint, the next polling tick
returns 503 and the table area swaps to the panel rather than
freezing on a stale snapshot. The panel disappears as soon as a
subsequent poll succeeds.

## Operating apply attempts (cleanup, runbook)

This section is for operators who watch the `apply_attempts` table
and the deployment-side scheduler that drives its cleanup. The
user-facing meaning of the lifecycle states (`failed_retryable` vs
`failed_terminal`, retry vs rebuild) is documented above under
[Bulk apply](#bulk-apply) and [Apply preview](#apply-preview); this
section maps the same states to operational symptoms and to the
runbook entry that keeps the table healthy.

### Row lifetimes (TTL and retention)

Every row in `apply_attempts` carries an `expires_at` cap. The cap
is rewritten on each lifecycle transition, so its meaning depends
on the row's current status:

- **30 minutes** (`APPLY_ATTEMPT_TTL_MS`) — when a row is created
  it is `pending` and `expires_at` is set to creation + 30 min.
  This TTL applies only while the row is `pending` or, after a
  retryable failure, `failed_retryable`. Past `expires_at` the
  cleanup TTL sweep terminalises those two statuses (`pending →
  expired`, `failed_retryable → failed_terminal`) and rewrites
  `expires_at` to the retention horizon below; the user must
  rebuild the plan from a fresh preview.
- **2.5 hours** (`APPLY_EXECUTING_STALE_MS`) — `executing` rows
  are **not** subject to the 30-minute TTL. The atomic claim
  promotes a `pending` row to `executing` without rewriting
  `expires_at`, but the TTL sweep skips any row holding an
  `executing_lock`, so an `executing` row may legitimately
  outlive the original 30-minute deadline until it either
  completes (transition to `succeeded` / `failed_retryable` /
  `failed_terminal`) or its `claim_started_at` ages past
  `APPLY_EXECUTING_STALE_MS`. The recovery sweep then treats it
  as a stuck claim, flips the row to `failed_terminal`, and
  cascades the in-flight + remaining queued dispatches to
  `failed_terminal` with the abandonment `lastError`. The user
  sees the modal's rebuild prompt on a subsequent visit.
- **7 days** (`APPLY_ATTEMPT_RETENTION_MS`) — every terminal
  transition (`succeeded`, `failed_terminal`, `stale`, `expired`)
  rewrites `expires_at = NOW() + retentionMs`. Retention is
  therefore measured **from the moment the row became terminal**,
  not from the original 30-minute deadline. The retention sweep
  hard-deletes terminal rows once `NOW() > expires_at` again.

The retention sweep does **not** purge `succeeded` rows whose
`succeeded_audit_completed_at IS NULL` — those rows are exempt
until the recovery sweep has emitted the corresponding
`node.apply` audit (see the audit-emission contract documented
above under [Bulk apply](#bulk-apply)). The exemption keeps a
prolonged audit-DB outage from purging an audit-incomplete row
before the recovery sweep gets a chance to finish it.

### Cleanup endpoint

The cleanup sweep is exposed as the route handler at
`POST /api/internal/apply-attempts/cleanup`. The deployment
scheduler must drive the route on a fixed cadence; the startup +
inline pre-create sweep fallback is **not** the active path,
because it silently skips cleanup whenever the Next.js process is
idle — unsafe on multi-instance deployments where one instance is
idle and another is creating attempts.

The route is **internal-token guarded**. Every request must carry
`Authorization: Bearer <APPLY_INTERNAL_CLEANUP_TOKEN>`. The shared
secret is constant-time-compared to avoid a timing oracle. If the
env var is unset, the route refuses every request — the deployment
must explicitly set the token before scheduling. The handler runs
as a system actor and never reads the manager DB or dispatches to
external services; the recorder acceptance test asserts zero
outbound GraphQL during a pass.

A successful pass returns HTTP 200 with the per-sweep counters:

![Cleanup endpoint sample request and response](../../assets/node-apply-cleanup-response-en.png)

The four counters report what each sweep did in this pass:

| Counter | Meaning |
| :-- | :-- |
| `recovered` | Stale-lock rows flipped to `failed_terminal` after `claim_started_at` aged past `APPLY_EXECUTING_STALE_MS`. |
| `expired` | Rows TTL-terminalised: `pending → expired` and `failed_retryable → failed_terminal`. |
| `purged` | Terminal rows hard-deleted past their retention deadline (excluding the `succeeded` / audit-incomplete carve-out). |
| `auditsRecovered` | `succeeded` rows whose `node.apply` audit was driven to durable by the recovery pass (covers both slot-claimed-but-not-completed and slot-never-claimed windows). |

A failed pass returns HTTP 500 with `{ "error": "<message>" }`.
HTTP 401 indicates the bearer token is missing or wrong.

### Runbook entry — schedule the cleanup endpoint

Add the cleanup route to the deployment scheduler in your release
runbook. The recommended cadence is **every 5 minutes**: this is
well below the 30-minute non-terminal TTL window, so a transient
scheduler outage of one or two cycles cannot cause a non-terminal
row to outlive its `expires_at` unobserved.

1. Provision a strong random token for `APPLY_INTERNAL_CLEANUP_TOKEN`.
   Treat it like any other internal secret — store it in your
   secrets manager, rotate on a normal cadence, never check it in.
2. Set the env var on every BFF instance and on the scheduler that
   calls the route. The defaults for the three TTL knobs ship in
   [`.env.example`](https://github.com/aicers/aice-web-next/blob/main/.env.example)
   and are read at runtime, so leaving the env vars unset is the
   supported "use the documented default" path:

    ```text
    APPLY_ATTEMPT_TTL_MS=1800000         # 30 min
    APPLY_ATTEMPT_RETENTION_MS=604800000 # 7 days
    APPLY_EXECUTING_STALE_MS=9000000     # 2.5 h
    APPLY_INTERNAL_CLEANUP_TOKEN=        # set per environment
    ```

    Override only when the deployment has a documented reason
    (long-running external dispatchers may want a longer
    `APPLY_EXECUTING_STALE_MS`; a compliance window shorter than
    7 days may want a smaller `APPLY_ATTEMPT_RETENTION_MS`).

3. Wire a recurring caller (cron, Kubernetes `CronJob`, GitHub
   Actions schedule, etc.) that issues:

    ```bash
    curl -fsS -X POST \
      -H "Authorization: Bearer $APPLY_INTERNAL_CLEANUP_TOKEN" \
      "$BFF_BASE_URL/api/internal/apply-attempts/cleanup"
    ```

4. Verify the first scheduled run by tailing the scheduler logs and
   confirming the JSON body parses to the four counters above. A
   healthy first run on a quiet deployment usually reports all-zero
   counters; a non-zero `recovered` or `expired` on a first run
   after a long outage is expected and should drop back to zero on
   subsequent passes.

### Observability and alerts

Operators should monitor the cleanup pass like any other periodic
sweep:

- **HTTP failure rate.** Treat any non-200 response from the
  cleanup route as an incident. 401 means the token rotated without
  the scheduler being updated; 500 means the database transaction
  threw and should surface a stack trace in BFF logs.
- **`recovered > 0` alert.** A non-zero `recovered` count means at
  least one `executing` row was older than 2.5 h and got abandoned.
  This should be rare in a healthy deployment; a sustained non-zero
  trend points at executor crashes between claim and commit, not at
  user behaviour.
- **`auditsRecovered > 0` alert.** A non-zero count means at least
  one `succeeded` row needed the recovery sweep to drive its
  `node.apply` audit to durable. Investigate audit-DB latency or
  BFF-process lifecycle; sustained values point at audit-DB
  pressure rather than apply-side bugs.
- **Pass duration.** A pass is a state-machine transaction plus a
  separate audit-recovery loop and a retention transaction; on a
  healthy deployment the whole call returns in well under a second.
  Long-running passes signal lock contention with the lifecycle
  module.

### Mapping lifecycle states to operational symptoms

When reading incident logs against the `apply_attempts` table, the
row-level state names map to symptoms as follows. The user-side
meaning of each state is documented under [Bulk apply](#bulk-apply)
and is not restated here.

| Row state | Operator symptom |
| :-- | :-- |
| `failed_retryable` | Transient external failure within the original 30-min window. The same row will resume on the next user click; no operator action needed unless the soft-fail rate climbs. |
| `failed_terminal` | Per-dispatch retry cap exhausted, recovery-sweep abandonment, or TTL terminalisation. The dispatch's `lastError` carries the abandonment reason. |
| `stale` | Drift between apply-build and apply-confirm fingerprints — the canonical node changed between preview and confirm. No manager mutation and no external mutation were sent. |
| `expired` | Row aged past `expires_at` while still `pending` (user opened the modal and walked away for >30 min). No mutations were sent. |

The audit row with `action = 'node.apply'` and
`correlation_id = <attempt-id>` is the operator-side proof that an
apply ran end-to-end. Its absence on a row that reached `succeeded`
is recovered automatically by the next cleanup pass via
`auditsRecovered`; if that counter stays non-zero across many
passes, the audit DB is the suspect.

### Modal screenshots

Modal-state captures (planned dispatches, `failed_retryable` with
Retry, `failed_terminal` with Rebuild, mid-execution) live with
the [Apply preview](#apply-preview) and
[Apply preview from the detail page](#apply-preview-from-the-detail-page)
sections above and are not duplicated here. Operators triaging a
stuck row should open the same modal the user sees — every state
visible to the user is documented there.
