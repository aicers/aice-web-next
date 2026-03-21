# Backup and Restore Strategy

## Context

This document defines the backup and restore strategy for data managed by aice-web-next, based on the database architecture established in:

- **Discussion #32** §3 — DB Separation (`auth_db` + `audit_db` + `customer_db` per tenant)
- **Discussion #34** — Database Migration Strategy (migration runner, customer_db lifecycle)

### Scope

This strategy covers **databases owned by aice-web-next**: `auth_db`, `audit_db`, and `customer_db` instances. It does not cover:

- REview/Giganto data (owned by those services)
- Certificate and key material (managed separately through secret management)

---

## 1. Database Topology Recap

| Database | Instances | Contents |
| --- | --- | --- |
| **auth_db** | 1 | Accounts, roles, permissions, customers (metadata), account–customer mappings, sessions, password history, MFA credentials, system settings |
| **audit_db** | 1 | Audit logs (all account management and system events) |
| **customer_db** | 1 per customer | Customer-scoped input data and reports |

Key characteristics:

- `auth_db` is small (accounts, roles, and settings are low-cardinality) but **highly interconnected** — foreign keys tie accounts to roles, customers, and sessions.
- `audit_db` is append-heavy and grows over time. It references `auth_db` entities by value (not by FK constraint) and has different retention requirements. It must not be rolled back when `auth_db` is restored.
- Each `customer_db` is **independent** of other customer databases and varies in size depending on the customer's data volume.

---

## 2. Backup Units

### 2.1 auth_db — Whole-database backup

`auth_db` is backed up as a **single consistent unit** using `pg_dump`.

**Why not split by table group (settings vs. accounts vs. customers)?**

- **Referential integrity**: Tables reference each other through foreign keys (`account_customer → accounts + customers`, `sessions → accounts`, etc.). Restoring subsets from different points in time breaks these relationships.
- **Temporal consistency**: Restoring system settings to an earlier state while keeping accounts at the current state creates contradictions (e.g., an MFA policy rollback with MFA credentials registered after that point still present).
- **No size benefit**: The entire `auth_db` is expected to remain small (< 100 MB even at scale), so splitting provides no meaningful reduction in backup time or storage.

### 2.2 audit_db — Whole-database backup

`audit_db` is backed up as a **single consistent unit** using `pg_dump`, independently from `auth_db`.

**Why separate from `auth_db`?**

- **Independent restore**: Restoring `auth_db` (e.g., to recover from a misconfiguration) must not roll back audit records. The audit trail must survive `auth_db` restores.
- **Different retention**: Audit logs may need to be preserved for years (compliance), while `auth_db` backups roll over in 30 days.
- **Different growth pattern**: `auth_db` is small and stable; `audit_db` grows continuously with every recorded event.

### 2.3 customer_db — Per-customer backup

Each `customer_db` is backed up **independently** using `pg_dump`.

**Why per-customer rather than all-at-once?**

- **Tenant isolation**: The reason for having separate databases in the first place. Backup boundaries should match data isolation boundaries.
- **Independent recovery**: A corruption or accidental deletion in one customer's data should be recoverable without affecting others.
- **Size variation**: Customer databases may vary significantly in size; independent backups allow per-customer scheduling and retention policies.

---

## 3. Backup Schedule

| Backup unit | Method | Frequency | Retention |
| --- | --- | --- | --- |
| auth_db | `pg_dump --format=custom` | Daily | 30 days rolling |
| audit_db | `pg_dump --format=custom` | Daily | Configurable (potentially longer than auth_db due to compliance requirements) |
| Each customer_db | `pg_dump --format=custom` | Daily | Configurable per customer (default: 30 days) |

**Additional considerations:**

- On-demand backup before destructive operations (customer deletion, major setting changes) is recommended at the application level.
- PostgreSQL WAL archiving can be layered on top for point-in-time recovery (PITR) if the RPO requirement becomes tighter than 24 hours. This is an infrastructure-level decision and not covered here.

---

## 4. Restore Scenarios

### 4.1 Full disaster recovery

**Trigger**: Server failure, storage corruption, or complete data loss.

**Procedure**:
1. Provision a new PostgreSQL instance.
2. Restore `auth_db` from the latest backup.
3. Restore `audit_db` from the latest backup.
4. Query `auth_db` for the list of active customers.
5. Restore each `customer_db` from its latest backup.
6. Run the migration runner (Discussion #34) to apply any migrations newer than the backup.
7. Start the application.

**Data loss window**: Up to 24 hours (last daily backup).

### 4.2 Single customer data recovery

**Trigger**: Accidental data corruption or deletion within a specific customer's database.

**Procedure**:
1. Create a temporary database from the customer's backup.
2. Verify data integrity and identify the needed data.
3. Restore into the live `customer_db` (or replace it entirely).
4. `auth_db` is **not** touched — the customer record and account mappings remain intact.

### 4.3 System settings misconfiguration

**Trigger**: An administrator changes a setting (password policy, session timeout, etc.) incorrectly.

**Procedure**: Do **not** restore `auth_db` from backup. Instead:
1. Look up the previous value in the audit log (query `audit_db`, `details.before` field).
2. Apply the correction through the normal settings API/UI.

**Rationale**: Restoring `auth_db` to undo a setting change would also roll back every account change and session created since the backup — far more destructive than the original mistake. `audit_db` must not be restored alongside `auth_db` — audit logs must be preserved to maintain a complete record of what happened.

### 4.4 Accidental account deletion

**Trigger**: An administrator deletes an account by mistake.

**Procedure**: No backup restore needed. Account deletion is **soft delete** (Discussion #32), so the account record is retained. Reactivate the account by changing its status from `disabled` to `active`.

### 4.5 Customer deletion recovery

**Trigger**: A customer is deleted (Discussion #34: `DROP DATABASE` + remove from `auth_db`).

**Procedure**:
1. Restore the `customer_db` from the latest pre-deletion backup.
2. Re-create the customer record in `auth_db` (new row; the original `id` is **never reused** per Discussion #32).
3. Re-establish account–customer mappings as needed.

**Note**: This is the most involved recovery scenario because both `auth_db` and `customer_db` state must be coordinated. An on-demand backup taken immediately before customer deletion would minimize data loss.

---

## 5. Implementation Considerations

### 5.1 Backup execution

The backup process should be an **external scheduled job** (e.g., cron, Kubernetes CronJob), not embedded in the application code. The application is responsible for:

- Exposing the list of active customer database names (so the backup job knows which databases to back up).
- Triggering an on-demand backup before destructive operations (optional, application-level safeguard).

### 5.2 Backup storage

- Backups should be stored **off-host** (separate storage from the database server).
- Encryption at rest is recommended for backups containing sensitive data (encrypted email/phone fields in `auth_db` are already encrypted at the column level, but the backup file also contains password hashes and other sensitive metadata).

### 5.3 Backup verification

Periodically restore a backup to a temporary database and run the migration runner against it. This verifies both backup integrity and migration compatibility.

---

## 6. What This Strategy Does Not Cover

| Topic | Reason |
| --- | --- |
| WAL archiving / PITR | Infrastructure-level decision; can be layered on if needed |
| Certificate/key backup | Managed through secret management (OpenBao roadmap) |
| REview/Giganto data | Owned by those services |
| Automated backup tooling selection | Implementation detail; `pg_dump` is sufficient to start |

