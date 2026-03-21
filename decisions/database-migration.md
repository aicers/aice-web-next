## Overview

aice-web-next will use PostgreSQL directly for account management and related features. This document records the decisions made about schema and migration management.

## Why No ORM

We use **raw SQL with `pg`** instead of an ORM (Drizzle, Prisma, etc.) for the following reasons:

**1. Transparency for AI-driven development**
aice-web-next's development and debugging is primarily handled by AI. Raw SQL is fully explicit — the exact SQL being executed is always visible in the source. ORM translation layers obscure what is actually happening, making debugging harder for AI and humans alike.

**2. Better AI coverage**
SQL has decades of history and broad AI training coverage. Newer ORM APIs such as Drizzle (2022) have less coverage and more API churn, increasing the risk of AI generating outdated or incorrect code.

**3. SQL injection prevention without ORM**
SQL injection is prevented by parameterized queries, which `pg` supports natively. An ORM is not required for this.

**4. Sufficient type safety without ORM overhead**
TypeScript interfaces on query results catch type mismatches at compile time, providing adequate safety without the abstraction cost of a full ORM.

## Migration Strategy

We use **versioned SQL migration files** — the approach used by Flyway, Liquibase, and golang-migrate — with a custom runner instead of an external tool.

### File structure

Migration files are separated by database: `auth_db` (single instance for authentication and account data), `audit_db` (single instance for audit logs), and `customer_db` (one instance per customer for customer-scoped data), as defined in Discussion #32 §3.

```
migrations/
  auth/
    0001_init_accounts.sql          # DDL
    0002_add_sessions.sql           # DDL
    0003_backfill_account_status.ts # DML — same numbering, TypeScript
  audit/
    0001_init_audit_logs.sql        # DDL
  customer/
    0001_init_customer_schema.sql   # DDL
    ...

src/lib/db/
  client.ts    # Connection pool, query<T>(), withTransaction()
  migrate.ts   # Migration runner
```

The runner applies `migrations/auth/` to `auth_db`, `migrations/audit/` to `audit_db`, and `migrations/customer/` to every `customer_db` instance.

### Multi-replica coordination

In a multi-replica deployment, multiple instances start concurrently and can race the migration runner. The runner acquires a PostgreSQL advisory lock (`pg_advisory_lock`) before executing migrations and releases it on completion. Only one instance runs migrations; others wait for the lock and then skip already-applied migrations. This applies to `auth_db`, `audit_db`, and each `customer_db` independently.

### customer_db lifecycle

aice-web-next is the sole owner of every `customer_db` (see Discussion #32 §3). The migration runner handles three lifecycle scenarios:

**1. Startup — upgrade existing databases**
When the application starts, the runner:
1. Runs all pending `migrations/auth/` against `auth_db`.
2. Runs all pending `migrations/audit/` against `audit_db`.
3. Queries `auth_db` for the list of all active customers.
4. For each customer's database, runs any pending `migrations/customer/` migrations.
5. The application starts only after all migrations (auth + audit + every customer) succeed.

**2. Runtime — provision a new customer database**
When a System Administrator creates a customer (Discussion #32 §2.3):
1. `CREATE DATABASE` for the new customer. This creates an empty database with no tables.
2. Run all `migrations/customer/` files against the new database, in order, to build the full schema from scratch (tables, indexes, constraints, etc.).

Both steps run within the same request. If any migration fails, the database is dropped and the customer creation fails.

**3. Runtime — delete a customer database**
When a System Administrator deletes a customer:
1. `DROP DATABASE` for the customer's database.
2. Remove the customer record from `auth_db`.

Both steps run within the same request.

### Version tracking

The runner maintains a `_migrations` table in each database:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

On each run, the runner compares migration files on disk against the `_migrations` table and applies only unapplied migrations, in order. Each migration is executed inside a single database transaction — if any statement fails, the entire migration is rolled back and no `_migrations` row is inserted. For rare cases where a statement cannot run inside a transaction (e.g., `CREATE INDEX CONCURRENTLY`), the migration file must be isolated (one statement per file) and marked with a `-- no-transaction` comment that the runner recognizes.

**Checksum validation**: The runner computes a SHA-256 hash of each migration file's contents and stores it in the `checksum` column on first apply. On subsequent runs, if an already-applied file's checksum does not match the stored value, the runner aborts with an error. This detects accidental edits to applied migrations and drift between environments (same pattern as Flyway).

### DDL vs. DML

- **Schema changes (DDL)**: `.sql` files, numbered sequentially.
- **Data migrations (DML)**: `.ts` files using the `pg` client, same numbering sequence. The runner applies DDL before DML within the same version.

### Migration granularity

Migration files are created **per logical change**, not per release. A release may include multiple migration files, or none if the schema did not change.

## Development Workflow

1. **Iterate locally** — make schema changes directly against a local database while developing; no migration file is needed yet.
2. **Write the migration file** — when a change is ready, write the next numbered file.
3. **Include in PR** — the migration file and the code that depends on it must be in the same PR.
4. **CI validation** — CI runs the runner against a clean database; PRs that fail cannot be merged.
5. **Deployment** — the runner runs before the application starts, migrating `auth_db`, `audit_db`, and all existing `customer_db` instances (see *customer_db lifecycle §1* above); the application only starts after all migrations succeed.

## Rollback

We adopt a **forward-only** approach. Rollbacks are implemented as new migration files that undo the previous change, not by reversing migrations in place.

**Rolling-deploy compatibility (expand/contract)**: In a multi-replica deployment, old and new app versions coexist during rollout. Destructive schema changes (column drop, column rename, type change) must be split across at least two releases:
1. **Expand**: Add the new column, backfill data, update app code to read/write both old and new columns.
2. **Contract** (next release): Remove the old column after all replicas run the new code.

This prevents old replicas from breaking when they encounter a schema they do not expect. Non-destructive additions (new table, new nullable column) can be applied in a single release.

