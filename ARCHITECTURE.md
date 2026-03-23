# Architecture

`aice-web-next` is a full-stack web application built with Next.js. It serves
the browser UI and acts as a BFF (Backend For Frontend), mediating all
communication between the browser and `review-web` (the GraphQL backend).

## System overview

```text
Browser ──► Next.js (aice-web-next) ──► review-web (GraphQL)
              │         │                    │
              │         ├─► auth_db (PG)     ├─ mTLS handshake
              │         ├─► audit_db (PG)    ├─ Context JWT verification
              │         └─► customer_db (PG) └─ RoleGuard + CustomerIds
              │
              ├─ Route Handlers
              ├─ Server Actions
              └─ React Server Components
```

The browser never accesses `review-web` directly. Every GraphQL request
originates from the server side of Next.js. `aice-web-next` is the sole owner
of `auth_db`, `audit_db`, and `customer_db`
(see [`decisions/account-management.md`](decisions/account-management.md) §3).

## Authentication flow

### Browser ↔ BFF

1. The user submits credentials to `/api/auth/sign-in` (Route Handler).
2. The BFF validates the credentials, issues a self-signed JWT, and stores it
   in an `HttpOnly Secure` cookie.
3. Subsequent requests include the cookie automatically. The BFF validates it
   on each request.

The BFF uses **Access Token only** — no Refresh Token. Token lifetime is
extended via **Sliding Rotation**: each server request within the validity
window issues a replacement token with a reset expiry. A single BFF instance
handles all requests, so the "stateless JWT to avoid DB lookups" benefit of
Refresh Tokens does not apply; `sid` validation already requires a DB lookup
on every request
(see [`decisions/account-management.md`](decisions/account-management.md) §7).

Authentication endpoints (`/api/auth/*`) are the **only** place where auth
logic lives. Server Actions handle business logic only.

### BFF ↔ review-web (mTLS + Context JWT)

1. The BFF presents its client certificate during the TLS handshake (mTLS).
2. `review-web` verifies the certificate against its trusted CA and extracts
   the peer public key.
3. For each GraphQL request, the BFF signs a **Context JWT** with the mTLS
   client certificate's private key and attaches it as a `Bearer` token.
4. `review-web` verifies the Context JWT signature using the peer public key
   obtained from the TLS handshake.

Context JWT payload (conforms to `review-web` `ContextClaims`):

```json
{ "role": "System Administrator", "customer_ids": [1, 2], "exp": 1700000000 }
```

- `role` — the user's role as a string (e.g., `"System Administrator"`)
- `customer_ids` — list of customer IDs the user can access (optional for
  `SystemAdministrator`)
- `exp` — expiration timestamp (short-lived, 5 minutes)

### Key handling

All mTLS and JWT signing logic is encapsulated in `lib/mtls.ts`:

- Certificate, private key, and CA are read once at startup.
- An `https.Agent` (for mTLS) and a `jose` signing key (for JWT) are derived
  from the same key material.
- The JWT algorithm is auto-detected from the certificate key type (RSA →
  RS256, EC P-256 → ES256, EC P-384 → ES384).
- Only capabilities are exported (`getAgent()`, `signContextJwt()`). Raw keys
  are never exposed.
- `reload()` atomically replaces both the Agent and the signing key for
  certificate rotation.

## Role system

aice-web-next defines three built-in roles and supports custom roles
(see [`decisions/account-management.md`](decisions/account-management.md) §1):

| Role | Scope | Deletable |
|------|-------|-----------|
| System Administrator | Full system, account, role, customer management | No |
| Tenant Administrator | Tenant-scoped ops + Security Monitor account management | No |
| Security Monitor | Event/dashboard read-only within assigned customer | No |
| Custom Role | System Administrator-defined permission combinations | Yes |

- Built-in roles are auto-created on first startup.
- Custom Role accounts are managed by System Administrator only.
  Tenant Administrator can only manage Security Monitor accounts.
- Next.js Middleware enforces role-based route protection. Server
  Actions and Route Handlers check permissions before executing.

## Data communication

### Three-layer architecture

| Layer | Direction | Technology | Transport |
|-------|-----------|------------|-----------|
| Client | Browser → BFF | TanStack Query | HTTP (fetch) |
| Server | BFF → review-web | graphql-request | HTTPS (mTLS) |
| DB | BFF → auth_db / audit_db / customer_db | pg | PostgreSQL protocol |

- **Client layer**: React components use TanStack Query to call Route Handlers
  or Server Actions. The browser has no knowledge of GraphQL.
- **Server layer**: Route Handlers and Server Actions use `graphql-request`
  with the mTLS `https.Agent` to query `review-web`.
- **DB layer**: Account management operations (auth, sessions, roles) query
  `auth_db` directly via `pg`. Audit events are written to `audit_db`.
  Customer-scoped data goes to the appropriate `customer_db`.

### Auth boundary

| Concern | Mechanism | Location |
|---------|-----------|----------|
| Sign-in / sign-out | Route Handler | `app/api/auth/` |
| Token rotation / CSRF (HMAC Double Submit Cookie) | Route Handler | `app/api/auth/` |
| Business mutations | Server Action (Next.js built-in CSRF) | `app/`, `lib/` |
| mTLS + Context JWT | Server-only module | `lib/mtls.ts` |

## Database architecture

aice-web-next is the sole owner of three PostgreSQL databases:

```text
PostgreSQL
├── auth_db        ← Accounts, roles, sessions (single instance)
├── audit_db       ← Immutable audit event log (single instance)
└── customer_db ×N ← Per-customer data (one instance per customer)
```

- **auth_db**: single instance storing all account management and
  authentication data.
- **audit_db**: single instance storing immutable audit events
  (auth, account, role, customer, and system operations). See
  [`decisions/audit-log.md`](decisions/audit-log.md) for the full
  specification.
- **customer_db**: one database per customer for tenant-scoped data.
  aice-web-next manages the full lifecycle: creation, schema migration,
  and deletion.
- Raw SQL with `pg` (no ORM). SQL is explicit and fully visible, which aids
  both human and AI-driven debugging. SQL injection is prevented by
  parameterized queries. See
  [`decisions/database-migration.md`](decisions/database-migration.md) for
  the full strategy.
- Schema changes use versioned SQL migration files (`migrations/auth/`,
  `migrations/audit/`, `migrations/customer/`) applied by a custom runner
  at startup and at runtime when customers are created.
- Forward-only: rollbacks are new migration files, not reverse operations.
- Backup strategy covers all three databases with different retention
  policies. See
  [`decisions/backup-restore.md`](decisions/backup-restore.md).

## Directory structure

```text
decisions/                   # Architecture decision records
  account-management.md
  audit-log.md
  backup-restore.md
  database-migration.md
  testing-strategy.md
  ui-architecture.md

docs/                        # User manual (EN + KR)
  en/
  ko/

migrations/
  auth/                      # auth_db migration files (versioned SQL/TS)
  audit/                     # audit_db migration files
  customer/                  # customer_db migration files

e2e/                         # Playwright E2E tests

src/
  __tests__/                 # Vitest unit tests (mirrors src/ structure)
  __integration__/           # Vitest integration tests (real PostgreSQL)
  app/
    [locale]/                # next-intl locale segment (/en/, /ko/)
      (auth)/                # Auth pages (sign-in)
      (dashboard)/           # Dashboard pages (accounts, roles, …)
    api/                     # Route Handlers
      auth/                  # Auth boundary (sign-in, sign-out, tokens)
      accounts/              # Account management
      audit-logs/            # Audit log queries
      customers/             # Customer CRUD
      dashboard/             # Dashboard data
      roles/                 # Role management
      system-settings/       # System settings
  lib/
    auth/                    # Auth logic (JWT, sessions, passwords, MFA, …)
    audit/                   # Audit logging (client, schema, correlation)
    db/                      # PostgreSQL client, migration runner
    graphql/                 # graphql-request client setup
    rate-limit/              # Rate limiter (sliding window)
    dashboard/               # Dashboard queries
    mtls.ts                  # mTLS + Context JWT encapsulation
  components/
    ui/                      # shadcn/ui primitives
    accounts/                # Account management UI
    audit/                   # Audit log UI
    customers/               # Customer management UI
    dashboard/               # Dashboard UI
    layout/                  # Sidebar, header, breadcrumbs
    roles/                   # Role management UI
    settings/                # System settings UI
  hooks/                     # Custom React hooks
  i18n/
    messages/                # Translation files (en.json, ko.json)
```

## Tech stack

### Runtime & framework

| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 24.x | Runtime |
| Next.js | 16.x | App Router, SSR/CSR, BFF |
| React | 19.x | UI |
| TypeScript | 5.x | Type system |
| pnpm | 10.x | Package manager |

### UI & styling

| Technology | Version | Purpose |
|------------|---------|---------|
| Tailwind CSS | v4.x | CSS framework |
| shadcn/ui | — | UI component library |

### Form & validation

| Technology | Version | Purpose |
|------------|---------|---------|
| React Hook Form | 7.x | Form management |
| Zod | v4.x | Schema validation |
| @hookform/resolvers | — | RHF + Zod bridge |

### Data & auth

| Technology | Version | Purpose |
|------------|---------|---------|
| TanStack Query | v5.x | Client-side server state |
| graphql-request | 7.x | Server-side GraphQL client |
| pg | 8.x | PostgreSQL client (raw SQL) |
| jose | — | Context JWT signing |

### i18n

| Technology | Version | Purpose |
|------------|---------|---------|
| next-intl | 4.x | Locale routing, translations |

### Development & testing

| Technology | Version | Purpose |
|------------|---------|---------|
| Biome | v2.x | Linting + formatting |
| Vitest | v4.x | Unit / component tests |
| React Testing Library | 16.x | Component tests |
| Playwright | 1.58.x | E2E tests |

### Infrastructure

| Technology | Purpose |
|------------|---------|
| Docker (Debian bookworm) | Containerization |
| Nginx | HTTPS reverse proxy, TLS termination |

## Testing

Tests are organized into three tiers. See
[`decisions/testing-strategy.md`](decisions/testing-strategy.md) for the
rationale and migration plan.

| Tier | Tool | Directory | Command |
|------|------|-----------|---------|
| Unit | Vitest | `src/__tests__/` | `pnpm test` |
| Integration | Vitest + real PG | `src/__integration__/` | `pnpm test:integration` |
| E2E | Playwright | `e2e/` | `pnpm e2e` |

## References

### Internal decisions

- [`decisions/account-management.md`](decisions/account-management.md) —
  Account management feature specification
- [`decisions/audit-log.md`](decisions/audit-log.md) —
  Audit logging architecture
- [`decisions/backup-restore.md`](decisions/backup-restore.md) —
  Backup and restore strategy
- [`decisions/database-migration.md`](decisions/database-migration.md) —
  Database migration strategy
- [`decisions/testing-strategy.md`](decisions/testing-strategy.md) —
  Three-tier testing architecture
- [`decisions/ui-architecture.md`](decisions/ui-architecture.md) —
  UI architecture and design tokens

### External

- [aicers/patio#556](https://github.com/orgs/aicers/discussions/556) —
  Authentication and data flow architecture
- [aicers/review-web#768](https://github.com/aicers/review-web/issues/768) —
  mTLS + Context JWT on review-web side
