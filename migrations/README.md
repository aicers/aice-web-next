# Database Migrations

This project uses a custom migration runner (`src/lib/db/migrate.ts`) to manage schema changes across three database categories: **auth**, **audit**, and **customer**.

## Directory layout

```
migrations/
  auth/        # Auth database (shared, single instance)
  audit/       # Audit database (shared, single instance)
  customer/    # Customer databases (one per tenant)
```

## File naming

```
<version>_<description>.sql
```

- `version` is a zero-padded numeric prefix (e.g., `0001`, `0002`).
- Files are applied in lexicographic order of their filename.

## Safety features

### Checksum validation

Every applied migration is stored with a SHA-256 checksum. On subsequent runs the runner verifies that the file on disk still matches the recorded checksum. A mismatch aborts the run immediately — never silently re-apply or skip a modified migration.

Existing rows without a checksum (from before this feature) are backfilled on the first run after upgrade.

### Advisory locking

The runner acquires a PostgreSQL advisory lock before executing migrations. When multiple application replicas start simultaneously, only one runs the migrations; the others wait for the lock and then skip already-applied files.

### Per-migration transactions

Each migration runs inside a `BEGIN`/`COMMIT` block. If the migration fails, the transaction is rolled back and the runner aborts.

## `-- no-transaction` migrations

Some DDL statements (e.g., `CREATE INDEX CONCURRENTLY`) cannot run inside a transaction. For these cases, add `-- no-transaction` as the **very first line** of the migration file:

```sql
-- no-transaction
CREATE INDEX CONCURRENTLY idx_logs_created ON audit_logs (created_at);
```

When the runner sees this marker it executes the file outside a transaction wrapper.

**Convention**: keep no-transaction migrations to one statement per file. The runner does not enforce this — it simply skips `BEGIN`/`COMMIT` — but mixing multiple statements without a transaction is inherently risky.

## Expand/contract pattern for rolling deploys

Destructive schema changes (dropping columns, renaming tables, changing types) must be split across two or more releases:

1. **Expand** — add the new column/table, deploy code that writes to both old and new.
2. **Contract** — after all replicas use the new schema, drop the old column/table in a subsequent release.

This ensures zero-downtime deploys where old and new code coexist briefly.
