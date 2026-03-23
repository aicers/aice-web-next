# aice-web-next

Web UI for AICE, built with Next.js. Acts as a BFF (Backend For Frontend),
mediating all communication between the browser and `review-web` (GraphQL
backend).

**[User Manual](docs/en/index.md)** · **[사용자 매뉴얼](docs/ko/index.md)** · **[Architecture](ARCHITECTURE.md)**

## Getting started

### Prerequisites

- Node.js 24.x
- pnpm 10.x
- PostgreSQL 18 (or Docker Compose)

### Setup

```bash
pnpm install
cp .env.example .env.local   # then fill in values (see below)
```

Start PostgreSQL (via Docker Compose or a local instance), then:

```bash
pnpm dev
```

Open <http://localhost:3000> to see the result.

## Environment variables

Copy `.env.example` to `.env.local` and fill in the values:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string for `auth_db` |
| `DATABASE_ADMIN_URL` | Admin connection to create databases at runtime |
| `AUDIT_DATABASE_URL` | PostgreSQL connection string for `audit_db` |
| `REVIEW_GRAPHQL_ENDPOINT` | `review-web` GraphQL endpoint URL |
| `MTLS_CERT_PATH` | Path to the mTLS client certificate |
| `MTLS_KEY_PATH` | Path to the mTLS private key |
| `MTLS_CA_PATH` | Path to the mTLS CA certificate |
| `DATA_DIR` | Directory for runtime data (default: `./data`) |
| `JWT_EXPIRATION_MINUTES` | Access token lifetime in minutes |
| `CSRF_SECRET` | Secret for CSRF token HMAC |
| `INIT_ADMIN_USERNAME` | Initial System Administrator username |
| `INIT_ADMIN_PASSWORD` | Initial System Administrator password |
| `DEFAULT_LOCALE` | Default locale (`en` or `ko`) |

## Scripts

### Testing

```bash
pnpm test               # Unit tests (Vitest)
pnpm test:integration   # Integration tests (Vitest + real PostgreSQL)
pnpm e2e                # E2E tests (Playwright)
```

### Linting and type checking

```bash
pnpm lint               # Biome lint check
pnpm check              # Biome CI (lint + format, errors on warnings)
pnpm format             # Auto-format with Biome
pnpm typecheck          # TypeScript type check (no emit)
```

## Project structure

```text
decisions/       Architecture decision records
docs/            User manual (EN + KR)
migrations/      Versioned SQL migration files (auth, audit, customer)
e2e/             Playwright E2E tests
src/
  app/           Next.js App Router (pages, layouts, API routes)
  lib/           Server-side logic (auth, audit, db, graphql, mTLS)
  components/    React components (ui, feature modules)
  hooks/         Custom React hooks
  i18n/          Translations (en.json, ko.json)
  __tests__/     Unit tests
  __integration__/  Integration tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system overview and
the `decisions/` directory for detailed design records.

## HTTPS

Production deployments must be served over HTTPS. The nginx reverse
proxy handles TLS termination and redirects all HTTP traffic to HTTPS.

### Production

The production nginx config (`infra/nginx/nginx.prod.conf`) enables:

- HTTP → HTTPS redirect (port 80 → 443)
- HSTS with a 1-year `max-age` and `includeSubDomains`
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`

The `__Host-csrf` cookie and `Secure` flag on the access token cookie
are automatically enabled when `NODE_ENV=production` (set by the
Dockerfile).

### Development with Docker Compose

```bash
# Generate self-signed TLS certificates (one-time)
mkdir -p infra/certs
mkcert -install  # trust the local CA (optional, avoids browser warnings)
mkcert -key-file infra/certs/dev.key -cert-file infra/certs/dev.crt localhost

# Start nginx + PostgreSQL
docker compose --profile dev up -d

# Start the Next.js dev server (in a separate terminal)
pnpm dev
```

Visit <https://localhost>. Nginx terminates TLS and proxies to
`localhost:3000`.

If you don't have `mkcert`, self-signed certificates also work but
the browser will show a security warning:

```bash
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout infra/certs/dev.key -out infra/certs/dev.crt \
  -days 365 -subj '/CN=localhost'
```

### Development without Docker

Running `pnpm dev` directly serves over HTTP on port 3000. This is
acceptable for local development because `NODE_ENV` is not
`production`, so:

- The CSRF cookie uses `csrf` instead of `__Host-csrf`
- The `Secure` flag is not set on cookies
- No HSTS or security headers are applied (these come from nginx)
