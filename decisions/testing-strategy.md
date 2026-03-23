# Testing Strategy

## Context

aice-web-next started with two test layers: Vitest unit tests (mocked DB) and Playwright E2E tests (real DB + browser). Over time, most real-DB verification ended up inside E2E — 22 of 23 specs import `e2e/helpers/setup-db.ts` (700+ lines, 29 exports), and many of those tests verify API/DB business logic without needing a browser.

This creates two problems:

1. **Slow feedback** — every DB logic check requires Playwright to launch a browser.
2. **Unclear failure cause** — a failing test could be DB logic, API wiring, or UI rendering.

Related: #183

---

## 1. Three-Tier Test Architecture

| Layer | Runner | DB | Browser | Speed | What it verifies |
|---|---|---|---|---|---|
| Unit | Vitest | mock | no | fast | Pure logic, input/output transforms, validation rules |
| Integration | Vitest | real PG | no | medium | API route handlers against real `auth_db`, `audit_db`, `customer_db` |
| E2E | Playwright | real PG | yes | slow | User-facing flows that require navigation, cookies, or rendering |

### Why not just two layers

Unit tests with mocked DB cannot catch real SQL bugs. E2E tests with a browser are too slow and noisy for verifying DB business rules. The integration layer fills the gap: real database, no browser overhead.

## 2. DB Harness

### Problem

Migrations and bootstrap run inside `instrumentation.ts` at Next.js startup. Vitest integration tests do not start a Next.js server, so they need an equivalent setup.

### Solution

A Vitest `globalSetup` file that:

1. Connects to PostgreSQL using `DATABASE_ADMIN_URL`.
2. Creates fresh test databases (`auth_db_test`, `audit_db_test`) or resets them by dropping and recreating.
3. Runs `migrateAuthDb()` and `migrateAuditDb()` from `src/lib/db/migrate.ts`.
4. Runs `bootstrapAdminAccount()` from `src/lib/auth/bootstrap.ts`.
5. Generates a JWT signing key (same as `e2e/global-setup.ts`).
6. Exports database URLs for use in test files.

### Required environment variables

Integration tests require the same three database URLs as E2E:

- `DATABASE_URL` — `auth_db` connection
- `DATABASE_ADMIN_URL` — superuser connection for DDL (CREATE/DROP DATABASE)
- `AUDIT_DATABASE_URL` — `audit_db` connection

### Test isolation

Tests run sequentially (`pool: 'forks'`, single thread) to avoid DB state conflicts — same approach as the current Playwright setup (`workers: 1`). Each test file is responsible for setting up and cleaning up its own data using shared helpers (ported from `e2e/helpers/setup-db.ts`).

## 3. Migration Scope

### Specs to migrate (API/DB business logic — no browser needed)

These specs primarily verify API responses and DB state transitions:

- `roles.spec.ts` — role CRUD API
- `customers.spec.ts` — customer CRUD API
- `account-customers.spec.ts` — account-customer assignment API
- `rbac.spec.ts` — permission enforcement (403 responses)
- `audit-logs.spec.ts` — audit log API filtering
- `system-settings.spec.ts` — settings read/write API
- `lockout.spec.ts` — lockout state transitions
- `unlock.spec.ts` — unlock API
- `sign-out-all.spec.ts` — session invalidation
- `rate-limit.spec.ts` — rate limiting
- `error-messages.spec.ts` — API error responses for account states
- `i18n-errors.spec.ts` — localized API error messages

### Specs to keep in E2E (browser required)

These specs depend on browser navigation, form interaction, cookie handling, or rendering:

- `auth.spec.ts` — sign-in/sign-out flow, redirects, protected route navigation
- `auth-flow.spec.ts` — sign-in reason screens, button clicks
- `csrf.spec.ts` — CSRF token + Origin header enforcement with browser cookies
- `must-change-password.spec.ts` — redirect to /change-password after sign-in
- `change-password.spec.ts` — form filling, submission, page redirects
- `ui-regression.spec.ts` — logo, avatar, sidebar rendering
- `preferences.spec.ts` — preference page UI, locale/timezone form
- `dashboard.spec.ts` — dashboard rendering, permission-based visibility

### Mixed specs (split by test case)

- `session-policy.spec.ts` — API timeout checks → integration; browser session monitoring → E2E
- `session-extension.spec.ts` — extension logic → integration; dialog rendering → E2E
- `accounts.spec.ts` — account API CRUD → integration; account UI forms → E2E

## 4. Project Structure

```text
vitest.config.ts              # Unit tests (existing, unchanged)
vitest.integration.config.ts  # Integration tests (new)

src/__tests__/                # Unit tests (existing)
src/__integration__/          # Integration tests (new)
  helpers/
    setup-db.ts               # DB helpers (ported from e2e/helpers/setup-db.ts)
    auth.ts                   # Auth helpers (ported from e2e/helpers/auth.ts)
  api/
    roles.test.ts
    customers.test.ts
    ...

e2e/                          # E2E tests (trimmed to browser-only flows)
```

## 5. Scripts and CI

### package.json scripts

- `pnpm test` — unit tests (unchanged)
- `pnpm test:integration` — integration tests (`vitest run --config vitest.integration.config.ts`)
- `pnpm e2e` — E2E tests (unchanged)

### CI pipeline

```text
Check (lint, typecheck)
  ├── Unit Tests (pnpm test) — no DB
  ├── Integration Tests (pnpm test:integration) — PostgreSQL service
  └── E2E Tests (pnpm e2e) — PostgreSQL service + browser
Docker Build
```

Integration and E2E jobs share the same PostgreSQL service configuration but run as separate CI steps. Integration tests run before E2E to provide faster feedback on DB logic failures.
