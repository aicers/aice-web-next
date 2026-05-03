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
cp .env.example .env.local   # local dev (pnpm dev). See env-file note below.
```

Start PostgreSQL (via Docker Compose or a local instance), then:

```bash
pnpm dev
```

Open <http://localhost:3000> to see the result.

## Environment variables

Pick the right env file for the path you are running:

- **Local dev (`pnpm dev`):** Next.js loads `.env.local` (and `.env`)
  from the project root, per the standard
  [Next.js env-loading rules](https://nextjs.org/docs/app/guides/environment-variables).
  Most contributors put their secrets in `.env.local`.
- **Production Docker Compose (`docker compose --profile prod up`):**
  the `next-app` service has `env_file: .env` in `docker-compose.yml`,
  so the prod profile **only** reads `.env`. `.env.local` is ignored
  by Compose. Operators deploying with the prod profile must populate
  `.env`.

Copy `.env.example` to whichever file matches your path and fill in
the values:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string for `auth_db` |
| `DATABASE_ADMIN_URL` | Admin connection to create databases at runtime |
| `AUDIT_DATABASE_URL` | PostgreSQL connection string for `audit_db` |
| `REVIEW_GRAPHQL_ENDPOINT` | `review-web` (manager) GraphQL endpoint URL |
| `GIGANTO_GRAPHQL_ENDPOINT` | Giganto GraphQL endpoint URL (direct mTLS, not proxied through review-web) |
| `TIVAN_GRAPHQL_ENDPOINT` | Tivan GraphQL endpoint URL (direct mTLS, not proxied through review-web) |
| `MTLS_CERT_PATH` | Path to the mTLS client certificate |
| `MTLS_KEY_PATH` | Path to the mTLS private key |
| `MTLS_CA_PATH` | Path to the mTLS CA certificate |
| `DATA_DIR` | Directory for runtime data (default: `./data`). When the prod compose profile runs, this directory is backed by the `next-app-data` named volume so JWT keys survive container restarts. |
| `JWT_EXPIRATION_MINUTES` | Access token lifetime in minutes |
| `JWT_SIGNING_KEY_FILE` | Path to an externally managed ES256 signing key (e.g. K8s Secret mount, Vault csi driver). Takes precedence over `<DATA_DIR>/keys/jwt-signing.json`. **Recommended for production.** When set, the previous key still loads from `<DATA_DIR>/keys/jwt-signing.prev.json` unless `JWT_SIGNING_KEY_FILE_PREVIOUS` is also set. |
| `JWT_SIGNING_KEY_FILE_PREVIOUS` | Optional override for the previous (rotated-out) key path. |
| `JWT_SIGNING_KEY_AUTOGEN` | Set to `1` / `true` / `on` to generate `<DATA_DIR>/keys/jwt-signing.json` on first boot when missing. Idempotent — re-boots load the existing key. **Single-instance only**: every replica would generate its own key, breaking inter-replica session validation. Multi-replica deployments must inject a shared key via `JWT_SIGNING_KEY_FILE` instead. Boot fails fast when `DATA_DIR` is not writable. |
| `EXPECTED_ORIGIN` | Override the expected request Origin for the CSRF/Origin guard (e.g. `https://app.example.com`). Required when the app is fronted by a TLS-terminating reverse proxy — browsers send `Origin: https://...` while the upstream sees `http://...`, and the mutation guard would otherwise reject every POST/PUT/PATCH/DELETE. Canonicalized at parse time (trailing slash stripped, scheme + host lowercased). When unset, behavior is unchanged from today (`request.nextUrl.origin` only). |
| `CSRF_SECRET` | Secret for CSRF token HMAC |
| `INIT_ADMIN_USERNAME` | Initial System Administrator username |
| `INIT_ADMIN_PASSWORD` | Initial System Administrator password |
| `DEFAULT_LOCALE` | Default locale (`en` or `ko`) |
| `APPLY_ATTEMPT_TTL_MS` | Execution deadline for a non-terminal apply attempt (default: 30 minutes) |
| `APPLY_ATTEMPT_RETENTION_MS` | Retention horizon for a terminal apply attempt before hard-delete (default: 7 days) |
| `APPLY_EXECUTING_STALE_MS` | Stale-lock recovery threshold for `executing` apply attempts (default: 2.5 hours) |
| `APPLY_DISPATCH_MAX_ATTEMPTS` | Per-dispatch retry cap before `failed_terminal` (default: 3) |
| `APPLY_INTERNAL_CLEANUP_TOKEN` | Shared secret for `POST /api/internal/apply-attempts/cleanup`; route refuses every request if unset |
| `NEXT_PUBLIC_NODE_STATUS_POLL_MS` | Polling cadence (ms) for the Nodes Status tab and detail-page dashboard. Default `10000`; values outside `[5000, 300000]` clamp to that range. The detail-page sparkline buffer length is a fixed 60 samples (`NODE_STATUS_SPARKLINE_SAMPLES` in `src/lib/node/status.ts`) and is not operator-configurable in v1; samples older than the cap are dropped on a rolling basis. |
| `NEXT_PUBLIC_GS_MODE` | Set to `1` / `true` / `on` to ship the gs-build subset of Hog `active_models`; anything else (or unset) ships the full set. Read at module load by `src/lib/node/active-models.ts`. |

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
schemas/         Vendored GraphQL SDL from upstream backends (REview, …)
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

## Backend schema versions

The `schemas/` directory holds vendored GraphQL SDL from the backends this
BFF targets. Each backend has its own SDL file because the Node management
layer dispatches directly to each service rather than relaying through
review-web — every query document must validate against the SDL of the
service that will actually answer it.

| File | Backend | Scope |
|------|---------|-------|
| `schemas/review.graphql` | `review-web` (REview, the manager) | Detection, Triage, and Node management menus |
| `schemas/review.version` | — | Semver of the REview release the SDL corresponds to |
| `schemas/giganto.graphql` | Giganto (data store) | Per-service `status` / `config` / `updateConfig` for the Giganto external service |
| `schemas/giganto.version` | — | Semver of the Giganto release the SDL corresponds to |
| `schemas/tivan.graphql` | Tivan (TI container) | Per-service `status` / `config` / `updateConfig` for the Tivan external service |
| `schemas/tivan.version` | — | Semver of the Tivan release the SDL corresponds to |

These files are **manually provided** by the engineer doing the update —
there is no auto-fetch script. The manual review step is intentional, so
breaking changes from upstream are caught at PR time rather than in
production.

### CI validation

Every CI run validates every GraphQL query document the BFF can send
against the correct vendored SDL — manager queries against
`schemas/review.graphql`, Giganto queries against
`schemas/giganto.graphql`, and Tivan queries against
`schemas/tivan.graphql`. A query validated against the wrong SDL must
fail. The check lives in
`src/__tests__/lib/graphql/schema-validation.test.ts` and covers:

- every `.graphql` / `.gql` file under `src/`, and
- inline GraphQL embedded in TypeScript sources. Detection is scoped
  to call/tag sites that actually produce a GraphQL document, via a
  TypeScript AST walk:
  - `` gql`…` `` tagged templates, where `gql` is imported from a
    known GraphQL package (`graphql-tag`, `graphql-request`,
    `@apollo/client`, `@urql/core`, `graphql`). Import aliases are
    supported.
  - `parse("…")` calls where `parse` is the named import from
    `graphql` (including `import * as graphql from "graphql"` with
    `graphql.parse("…")`).

  Arbitrary string literals that happen to start with `query` /
  `mutation` / `subscription` / `fragment` are deliberately ignored
  so unrelated code (e.g. `JSON.parse("query parameter")`) is not
  misclassified as GraphQL.

Dynamic construction of GraphQL documents in production code is
rejected by the same check. Interpolated `` gql`… ${x} …` ``
templates and `parse(variable)` / `graphql.parse(variable)` calls
produce a `DocumentNode` that cannot be statically validated against
the vendored schema, so the AST walk fails CI at those sites with a
message telling the contributor to inline the query as a string
literal or move it to a checked-in `.graphql` file. This closes the
escape hatch of building a `DocumentNode` from a runtime-assembled
string and passing it to `graphqlRequest`.

`src/lib/graphql/client.ts` also restricts `graphqlRequest` to
`DocumentNode` (no raw strings), with a runtime guard as
defense-in-depth, so drift cannot leak through an `as any` cast. A PR
that references a field not present in the vendored schema — whether
from a `.graphql` file, an inline `gql` template, or a `parse("…")`
call — fails CI with a message pointing back to this section.

### Update procedure

#### REview (`schemas/review.graphql`)

1. Obtain the target REview SDL by whatever means are available. There
   is no canonical location yet; REview does not currently ship an SDL
   file. The pragmatic option today is to build `review-web` locally
   with the `auth-mtls` feature and dump the SDL, e.g.:

   ```rust
   // examples/dump_sdl.rs in a review-web checkout
   use async_graphql::Schema;
   use review_web::graphql::{Mutation, Query, Subscription};

   fn main() {
       let schema = Schema::build(
           Query::default(),
           Mutation::default(),
           Subscription::default(),
       )
       .finish();
       println!("{}", schema.sdl());
   }
   ```

   `Schema`, `Query`, `Mutation`, `Subscription` are currently
   `pub(super)` in `review-web::graphql`; the current SDL in this
   repo was produced by temporarily widening their visibility to
   `pub`. Once REview exposes a stable SDL source, this step can be
   simplified.
2. Replace `schemas/review.graphql` with the new SDL (preserve the
   header comment that records the source and version).
3. Write the corresponding version (semver or commit SHA) into
   `schemas/review.version`.
4. Review `git diff schemas/` and update any code that references
   removed or renamed fields in the same PR.
5. Regenerate schema-derived TypeScript types:

   ```sh
   pnpm codegen:detection
   ```

   The generator at `scripts/codegen-detection-types.mjs` reads
   `schemas/review.graphql` and rewrites
   `src/lib/detection/types.generated.ts` (scalars, enums, the
   `EventListFilterInput` and its transitive inputs,
   `EventConnection`/`EventEdge`/`PageInfo`, the `eventCountsBy*`
   counter shapes, and an `EventBase` interface covering the Event
   interface's common fields). A Vitest spec re-runs the generator
   in CI and fails if the checked-in file drifts, so a schema bump
   that forgets this step is caught at PR time.
6. Commit the schema, version file, and regenerated types together.
   Call out any breaking-change mitigation in the PR description.

#### Giganto (`schemas/giganto.graphql`)

Giganto ships its SDL alongside its source tree at
`giganto/src/graphql/client/schema/schema.graphql`. To update:

1. Check out the desired Giganto release tag.
2. Copy `giganto/src/graphql/client/schema/schema.graphql` over
   `schemas/giganto.graphql`. Preserve the header comment that records
   the source and version.
3. Write the version (semver) into `schemas/giganto.version`.
4. Review `git diff schemas/` and update Giganto query documents in
   `src/lib/node/queries/external/giganto-*.graphql` if any field has
   been renamed or removed.

#### Tivan (`schemas/tivan.graphql`)

Tivan defines its schema in Rust via `async-graphql` and does not ship
an SDL file. To update, dump the SDL the same way as REview from a
Tivan checkout:

```rust
// examples/dump_sdl.rs in a tivan checkout
use async_graphql::{EmptySubscription, Schema};
use tivan::graphql::{Mutation, Query};

fn main() {
    let schema = Schema::build(Query::default(), Mutation::default(), EmptySubscription).finish();
    println!("{}", schema.sdl());
}
```

The current `schemas/tivan.graphql` was produced this way at tag
`0.3.1`. As with REview, the schema types may need to have their
visibility temporarily widened to `pub` for the dump to compile.

1. Replace `schemas/tivan.graphql` with the new SDL (preserve the
   header comment).
2. Write the version (semver) into `schemas/tivan.version`.
3. Review `git diff schemas/` and update Tivan query documents in
   `src/lib/node/queries/external/tivan-*.graphql` if any field has
   been renamed or removed.

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

`Content-Security-Policy-Report-Only` is emitted by the Next.js app
(per-request nonce — nginx leaves the header untouched). Enforcement
is staged: the Report-Only mode lands first to surface any inline
script/style breakages in real traffic before the header is promoted
to enforcing CSP.

The CSP nonce flow requires dynamic rendering — `app/[locale]/layout.tsx`,
`app/[locale]/not-found.tsx`, and `app/not-found.tsx` all call
`await connection()` so framework script tags receive a fresh
per-request nonce.  Any new page added under `app/` must do the same
(or have no `<script>` tags at all): a statically rendered HTML
response carries no per-request nonce and would be blocked once CSP
promotes from Report-Only to enforcing.  Verify with `pnpm build` —
the route map should mark every HTML route as `ƒ` (dynamic).

The `__Host-csrf` cookie and `Secure` flag on the access token cookie
are automatically enabled when `NODE_ENV=production` (set by the
Dockerfile).

#### First-boot deployment checklist

1. Populate `.env` (the prod compose profile reads `.env`, not
   `.env.local`). At minimum set `CSRF_SECRET`, the database URLs,
   the GraphQL endpoints, and:
   - `EXPECTED_ORIGIN=https://your.public.host` so the CSRF/Origin
     guard accepts mutation requests through the HTTPS proxy.
   - One of `JWT_SIGNING_KEY_FILE=<path>` (recommended — a Secret
     mount) or `JWT_SIGNING_KEY_AUTOGEN=1` (single-instance dev
     convenience).
2. Make sure the persistent data volume is in place. The
   `docker-compose.yml` shipped here mounts a named `next-app-data`
   volume on `/app/data`; if you customise this, mount your own
   volume at `${DATA_DIR}` so the JWT key (and any other persisted
   state) survives container restarts.
3. `docker compose --profile prod up -d`.

If autogen is requested but `DATA_DIR` is not writable by the
container user (uid 1001), the app fails fast at startup with a
clear error message instead of crash-looping mid-boot.

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
