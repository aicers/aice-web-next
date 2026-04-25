# Node & service management — RBAC decisions

This document defines the permission strings added to aice-web-next for the node and service management feature and their assignment to the three built-in roles.

Aligns with the existing pattern in `src/lib/auth/permission-defs.ts` (central permissions registry) and `migrations/auth/0002_roles.sql` (built-in role seeds). No new custom role types are introduced — the existing System Administrator / Tenant Administrator / Security Monitor model remains the seed.

## Local-state inventory

For this feature, aice-web-next adds exactly two categories of persistent local-DB state — and nothing else:

1. **RBAC additions** — the new permission strings and role grants defined in this document, owned by Phase Node-1 (#307).
2. **Transient apply-orchestration state** — the `apply_attempts` table introduced by Phase Node-9 (#314) and reused by Phase Node-12 (#333). Each row holds one in-flight or recently-finished apply plan with its `draft_fingerprint`, `planned_dispatches`, `created_by`, `status`, `created_at`, and `expires_at`. The table is **orchestration metadata, not a replica of manager-DB drafts** — drafts continue to live in the manager DB and are read fresh on every plan build. Rows are TTL-bound (30-minute non-terminal expiry, 7-day terminal retention) and purged on a scheduled cleanup job. Schema, indexes, and cleanup behaviour are owned by #314; this document is informational only.

No other persistent local-DB state is introduced by the node-and-service management feature. Status snapshots, sparkline buffers, and resource-history are client-side only.

## New permission groups

Two groups are added to `ALL_PERMISSIONS`:

```ts
ALL_PERMISSIONS.nodes    = ["nodes:read", "nodes:write", "nodes:delete"];
ALL_PERMISSIONS.services = ["services:read", "services:write"];
```

`services:*` is kept distinct from `nodes:*` so future custom roles can express finer-grained archetypes (e.g., a "service operator" who edits service configs but cannot create or delete nodes). The built-in roles in v1 grant both groups together or none.

No separate `services:apply` permission in v1. The "save draft" and "apply draft" actions both live under `services:write`; splitting them adds role-design overhead without a concrete user story demanding it. Revisit if an operator-vs-editor distinction emerges.

## Page-level combination rule — v1 requires both scopes

Node management pages are **mixed-surface**: every page in this feature shows both node metadata (nodes surface) and service information (services surface). In v1 the combination rule is uniform — a caller needs **both the read and write scope for the specific page** to reach it; Node pages do not degrade to a partial view.

| Page / action | Required permissions |
|---|---|
| Settings list page (`/nodes/settings`) | `nodes:read` **and** `services:read` |
| Status tab (`/nodes`) | `nodes:read` **and** `services:read` |
| Detail page (`/nodes/[id]`) | `nodes:read` **and** `services:read` |
| Create / edit dialog | `nodes:write` **and** `services:write` |
| Delete (single or bulk) | `nodes:delete` |
| Restart / Shutdown | `nodes:write` |
| **Save draft** (touches the whole-node `updateNodeDraft(id, old, new)`) | `services:write` **and** `nodes:write` |
| **Node-level bulk apply** (the only apply scope in v1 — touches `applyNode(id, node)` and, where relevant, follow-up `updateConfig` calls on external services as part of a single user-initiated bulk operation) | `services:write` **and** `nodes:write` |
| Per-service on/off toggle (deferred — see #317) | `services:write` |
| Configure Here / Manually mode change | `services:write` |

Rationale: every v1 write path that applies drafts traverses review-web's whole-node mutations and cannot safely gate a partial slice; both scopes are required. Per-service apply (for any service kind) is **out of v1 scope** and is tracked in Phase Node-12 (#333) pending review-web's applyNode split. **When per-service apply lands, its caller-side gate is `nodes:write + services:write`** — the same combination as bulk apply — because (a) the BFF reuses the same `apply_attempts` plan-carrier and dispatch executor that bulk apply introduces, (b) the executor still touches both the manager and (for external service kinds) the external GraphQL endpoint, and (c) BFF-side gates remain symmetric across apply paths so callers cannot side-step the node-level guard by choosing the per-service path. The review-web mutation's *server-side* guard may stay at `services:write` equivalent (review-web's own design); aice-web-next's BFF-side guard is stricter and that asymmetry is intentional.

A custom role holding only `nodes:read` (no `services:read`) currently exists — built-in roles always pair the two. Should a custom role emerge with that partial shape, the user receives a 403 on every Node page; the UI does not attempt to render a partial list.

## Permission semantics

| Permission | Grants | Notes |
|---|---|---|
| `nodes:read` | List all nodes the caller has customer access to; read a node's metadata, profile, and service membership | Required for the Settings list page and the node detail page |
| `nodes:write` | Create a node; edit node metadata (name, hostname, description); add / remove service membership on a node; trigger **node-level** control actions (restart, shutdown) | Covers everything except destructive delete |
| `nodes:delete` | Delete one or more nodes | Kept separate from `nodes:write` so a Tenant Administrator who can edit nodes can be denied delete if policy requires |
| `services:read` | Read service status (on/off/idle); read applied config; read draft config | Required on the Status tab and any service config viewer |
| `services:write` | Save draft config; apply draft (per-service or bulk at node level); toggle individual service on/off (when the server-side mutation ships); change a service's Configure Here / Configure Manually mode | Covers the entire editing + apply lifecycle |

## Built-in role grants

| Role | Grants |
|---|---|
| **System Administrator** | `nodes:read`, `nodes:write`, `nodes:delete`, `services:read`, `services:write` — unrestricted across all customers |
| **Tenant Administrator** | `nodes:read`, `nodes:write`, `nodes:delete`, `services:read`, `services:write` — **scoped to the customers assigned to the account** |
| **Security Monitor** | `nodes:read`, `services:read` — scoped to assigned customers, read-only |

Customer-scope enforcement is not a new concern for this feature — it reuses the existing tenant-scope helpers in `src/lib/auth/customer-scope.ts` that the accounts and customers features already rely on.

## Manager offline behaviour and permissions

When the upstream manager is offline, all node and service data is unreachable because aice-web-next owns no local copy of it. Permission checks do not change in this case: `nodes:read` / `services:read` holders continue to see the routes, but the pages surface a "cannot reach manager" state instead of 403. Permission failures (missing `nodes:read`, etc.) remain 403 with the standard redirect pattern used by the accounts feature.

## Audit log event names

Audit log entries follow the existing `AuditEvent` interface from `src/lib/audit/logger.ts`: `{ actor, action, target, targetId?, details?, ip?, sid?, customerId?, correlationId? }`. The table below gives the exact shape each sub-issue emits. Event emission is **one entry per affected target** (a multi-service save emits one entry per changed service; a bulk delete emits one entry per deleted node).

| Permission gate | `action` | `target` | `targetId` | `details` | Owner sub-issue |
|---|---|---|---|---|---|
| `nodes:write` (create) | `node.create` | `node` | `${nodeId}` | `{ name, hostname, customerId }` | Node-4 |
| `nodes:write` (edit, node metadata only) | `node.update` | `node` | `${nodeId}` | `{ changedFields: [...] }` (metadata fields only: `name`, `customerId`, `description`, `hostname`) | Node-4 |
| `nodes:delete` | `node.delete` | `node` | `${nodeId}` | `{ hostname }` (one entry per deleted node; bulk delete emits N entries) | Node-3 |
| `nodes:write` (restart) | `node.restart` | `node` | `${nodeId}` | `{ hostname }` | Node-6 |
| `nodes:write` (shutdown) | `node.shutdown` | `node` | `${nodeId}` | `{ hostname }` | Node-6 |
| `services:write` + `nodes:write` (draft save) | `service.draft_save` | `service` | `${nodeId}:${serviceKind}` | `{ serviceKind, nodeId }` (one entry per service whose draft changed) | Node-9 |
| `services:write` + `nodes:write` (node-level bulk apply) | `node.apply` | `node` | `${nodeId}` | `{ appliedServices: [...] }` | Node-9 |
| `services:write` (mode change) | `service.set_mode` | `service` | `${nodeId}:${serviceKind}` | `{ serviceKind, mode, nodeId }` | Node-4 |
| `services:write` (on/off) — *reserved, not in v1* | `service.set_state` | `service` | `${nodeId}:${serviceKind}` | `{ serviceKind, targetState, nodeId }` | Node-8 PR 3 |
| `nodes:write` + `services:write` (per-service apply, BFF caller-side) — *reserved, not in v1* | `service.apply` | `service` | `${nodeId}:${serviceKind}` | `{ serviceKind, nodeId }` | Node-12 |

Notes:

- `actor` is the authenticated account id (or `"system"`) and is filled by the caller uniformly; it is omitted from the per-event rows to keep the table readable.
- `target` values in use: `"node"` and `"service"`. These are added to `AuditTargetType` in Phase Node-1.
- `targetId` for service-scoped events is a composite `"${nodeId}:${serviceKind}"` so events on different services of the same node are individually addressable in the audit log (see the composite-`targetId` convention section).
- Sub-issues that consume this table in v1 are Phase Node-1 (audit schema extension), Phase Node-3 (delete), Phase Node-4 (create/update/set_mode), Phase Node-6 (restart/shutdown), Phase Node-9 (draft_save / node.apply). Phase Node-8 (`service.set_state`) and Phase Node-12 (`service.apply`) are out-of-scope for v1.
- `service.apply` and `service.set_state` are **reserved but not emitted in v1** for the same reason: their emitters are deferred to follow-on issues (Phase Node-12 / #333 and Phase Node-8 PR 3 / #317 respectively), and shipping an enum member with no emitter invites dead-code drift. Each follow-on issue extends `ServiceAction` and updates this section at activation time. v1's `ServiceAction` ships with `service.draft_save` and `service.set_mode` only.
- **`node.update` and `service.draft_save` are disjoint**: `node.update` (owned by Phase Node-4) fires only when persisted node-metadata fields changed (`name`, `customerId`, `description`, `hostname`); `service.draft_save` (owned by Phase Node-9) fires per changed-service draft. A dialog Save that edits only service drafts emits zero `node.update` entries. A dialog Save that edits only node metadata emits zero `service.draft_save` entries. A mixed Save emits one `node.update` plus one `service.draft_save` per changed service.

## Migration

Delivered via a new `migrations/auth/00NN_node_service_permissions.sql` file that:

1. Inserts the five new permission strings.
2. Grants them to the three built-in roles per the table above.
3. Is idempotent (safe to re-run) per the existing migration conventions.

The corresponding `permission-defs.ts` update, role-form-dialog render regression test, and bootstrap-sanity test update are part of the same sub-issue.

## Audit schema extension

aice-web-next's audit pipeline uses a closed `AuditAction` / `AuditTargetType` union defined in `src/lib/audit/schema.ts`. Emitting any of the Node / service events in the table above requires **extending those types first**; otherwise calls do not compile. The extension is **owned by Phase Node-1** (the permissions sub-issue) because it is infrastructure shared by every subsequent sub-issue that emits an event.

Phase Node-1 adds:

- `NodeAction`: `node.create` | `node.update` | `node.delete` | `node.restart` | `node.shutdown` | `node.apply`
- `ServiceAction`: `service.draft_save` | `service.set_mode`. Neither `service.set_state` nor `service.apply` is added in v1: `service.set_state` lands with Phase Node-8 PR 3 (#317 activation) alongside its emitter, and `service.apply` lands with Phase Node-12 (#333) alongside its emitter.
- Both joined into the `AuditAction` union.
- `AuditTargetType`: adds `node` | `service`.
- Matching runtime entries in `AUDIT_ACTIONS` and `AUDIT_TARGET_TYPES`.

The sub-issues that call `auditLog(...)` in v1 (Node-3 for delete, Node-4 for create/update/set_mode, Node-6 for restart/shutdown, Node-9 for draft_save / node.apply) rely on this extension already being in place. Out-of-v1 follow-ons that introduce additional emitters (Node-8 PR 3 for `service.set_state`, Node-12 for `service.apply`) extend the union themselves at activation time.

### `targetId` convention for service-scoped events

`service.*` actions are scoped to one service on one node. If the raw `nodeId` were used as `targetId`, every service event on a node would share a single audit target and consumers could not distinguish a Sensor event from a Data Store event on the same node. To keep events individually addressable:

- `node.*` events: `targetId = "${nodeId}"`.
- `service.*` events: `targetId = "${nodeId}:${serviceKind}"` (e.g. `"42:SENSOR"`, `"42:DATA_STORE"`). `details` still carries `{ serviceKind }` so consumers can filter without parsing the composite.
- `service.*` events that span multiple services in a single action (there are none in v1 — the multi-service save in Phase Node-9 emits **one entry per changed service**, each with its own composite `targetId`) would need a deliberate owner decision; do not introduce such an event type without updating this convention.

## Built-in role description refresh

`migrations/auth/0002_roles.sql` originally described built-in roles in terms of accounts, customers, events, and dashboards. The descriptions are stale after this feature lands. Phase Node-1 includes a second migration step that rewrites the `description` column for:

- **Tenant Administrator**: add "node and service management within assigned customers".
- **Security Monitor**: add "node and service status read-only within assigned customer" so the row is not dashboard-only.

System Administrator description already says "Full system" and does not need updating.

## Polling settings (note — no new permission)

The polling cadence for the Status tab and the node detail page is not gated by `system-settings:read`. In v1 it is exposed as the client-side environment variable `NEXT_PUBLIC_NODE_STATUS_POLL_MS` (read at bundle time, default 10000 ms, clamped to `[5000, 300000]`). Migrating this to a `system_settings`-backed key with per-role read access is a separate follow-up tracked outside this feature, so Phase Node-1 does not add a settings permission for Node.
