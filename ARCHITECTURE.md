# Architecture

`aice-web-next` is a full-stack web application built with Next.js. It serves
the browser UI and acts as a BFF (Backend For Frontend), mediating all
communication between the browser and `review-web` (the GraphQL backend).

## System overview

```text
Browser ──► Next.js (aice-web-next) ──► review-web (GraphQL)
              │                            │
              ├─ Route Handlers            ├─ mTLS handshake
              ├─ Server Actions            ├─ Context JWT verification
              └─ React Server Components   └─ RoleGuard + CustomerIds
```

The browser never accesses `review-web` directly. Every GraphQL request
originates from the server side of Next.js.

## Authentication flow

### Browser ↔ BFF

1. The user submits credentials to `/api/auth/sign-in` (Route Handler).
2. The BFF validates the credentials, issues a self-signed JWT, and stores it
   in an `HttpOnly Secure` cookie.
3. Subsequent requests include the cookie automatically. The BFF validates it
   on each request.

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

## Data communication

### Two-layer architecture

| Layer | Direction | Technology | Transport |
|-------|-----------|------------|-----------|
| Client | Browser → BFF | TanStack Query | HTTP (fetch) |
| Server | BFF → review-web | graphql-request | HTTPS (mTLS) |

- **Client layer**: React components use TanStack Query to call Route Handlers
  or Server Actions. The browser has no knowledge of GraphQL.
- **Server layer**: Route Handlers and Server Actions use `graphql-request`
  with the mTLS `https.Agent` to query `review-web`.

### Auth boundary

| Concern | Mechanism | Location |
|---------|-----------|----------|
| Sign-in / sign-out | Route Handler | `app/api/auth/` |
| Token rotation / CSRF | Route Handler | `app/api/auth/` |
| Business data queries | Server Action or Route Handler | `app/`, `lib/` |
| mTLS + Context JWT | Server-only module | `lib/mtls.ts` |

## Directory structure

```text
src/
  app/
    [locale]/              # next-intl locale segment (/en/, /ko/)
      layout.tsx
      page.tsx
    api/
      auth/                # Auth boundary — Route Handlers only
  lib/
    mtls.ts                # mTLS + Context JWT encapsulation
    graphql/               # graphql-request client setup
  components/
    ui/                    # shadcn/ui components
  i18n/
    messages/              # Translation files (en.json, ko.json)
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

## References

- [aicers/patio#556](https://github.com/orgs/aicers/discussions/556) —
  Authentication and data flow architecture
- [aicers/review-web#768](https://github.com/aicers/review-web/issues/768) —
  mTLS + Context JWT on review-web side
