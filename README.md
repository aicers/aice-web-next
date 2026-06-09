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
| `DATABASE_URL` | PostgreSQL connection string for `auth_db`. **The shipped `.env.example` value is host-side** (`localhost:5434`, for `pnpm dev` and host tooling). The prod compose profile passes `.env` directly into the `next-app` container, where `localhost` is the container itself — set this to `postgres://postgres:postgres@postgres:5432/auth_db` for prod. See the [first-boot deployment checklist](#first-boot-deployment-checklist) and `AICE_POSTGRES_HOST_PORT`. |
| `DATABASE_ADMIN_URL` | Admin connection to create databases at runtime. Same dev-vs-prod address split as `DATABASE_URL`; for prod use `postgres://postgres:postgres@postgres:5432/postgres`. |
| `AUDIT_DATABASE_URL` | PostgreSQL connection string for `audit_db`. Same dev-vs-prod address split as `DATABASE_URL`; for prod use `postgres://audit_writer:changeme@postgres:5432/audit_db`. |
| `AICE_POSTGRES_HOST_PORT` | Host port the compose `postgres` service publishes on. Default `5434` so aice-web-next does not collide with any other Postgres on the host. The compose `next-app` service still reaches Postgres at `postgres:5432` over the compose network — only the host-published port shifts. Operators with an existing 5432-bound deployment can override with `AICE_POSTGRES_HOST_PORT=5432` and update the host-side DSNs above accordingly. |
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
| `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN` | Shared secret for `POST /api/internal/triage/baseline/cadence`; route refuses every request if unset. Body shape: `{ "customer_id": <positive integer> }`. The deployment scheduler invokes this every 15 minutes per customer to drive Triage baseline corpus ingestion (1B-1). |
| `ENGAGEMENT_HMAC_KEY` | HMAC key for pseudonymizing pivot values, asset addresses, and `account_id` written to the Triage engagement store (`engagement_impression` / `engagement_action`). Set to base64 of ≥32 random bytes (e.g. `openssl rand -base64 48`); the helper decodes the env var at first use and rejects invalid base64 or anything that decodes to under 32 random bytes (so `openssl rand -base64 24`, which decodes to only 24 random bytes, fails fast). The key does **not** rotate — rotating would invalidate every historical row's join key, so future rotation requires an expand/contract migration that adds a `_key_version` column. See `src/lib/triage/engagement/hmac.ts`. |
| `TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN` | Shared secret for `POST /api/internal/triage/engagement/retention`; route refuses every request if unset. The in-repo cron service (`run-triage-engagement-retention.sh`, daily at 05:15 UTC) prunes `engagement_impression` rows older than 90 days and `engagement_action` rows older than 180 days. |
| `TRIAGE_BASELINE_RETENTION_INTERNAL_TOKEN` | Shared secret for the Triage Corpus A baseline retention route; route refuses every request if unset. The in-repo cron service (`run-triage-baseline-retention.sh`, daily at 03:15 UTC) sends it as a bearer token. |
| `TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN` | Shared secret for the Triage condition-snapshot retention route; route refuses every request if unset. The in-repo cron service (`run-triage-snapshot-retention.sh`, daily at 04:15 UTC) sends it as a bearer token. |
| `TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN` | Shared secret for the Triage Corpus B retention + zombie-reaper route; route refuses every request if unset. The in-repo cron service (`run-triage-policy-retention.sh`, every 6h) sends it as a bearer token. |
| `TRIAGE_EXCLUSION_FANOUT_TOKEN` | Shared secret for the Triage exclusion fan-out queue-drain route; route refuses every request if unset. The in-repo cron service (`run-triage-exclusion-fanout.sh`, every minute) sends it as a bearer token. |
| `AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN` | Shared secret for the Aimer Phase 2 manual-mint retention route; route refuses every request if unset. The in-repo cron service (`run-aimer-phase2-manual-mint-retention.sh`, daily at 06:15 UTC) sends it as a bearer token. |
| `AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN` | Shared secret for the operator-triggered Aimer Phase 2 backfill route (`src/lib/aimer/phase2/backfill.ts`); no scheduled wrapper. Route refuses every request if unset. |
| `TRIAGE_EXCLUSION_RECOVERY_INTERNAL_TOKEN` | Shared secret for the operator-triggered Triage exclusion recovery sweep (`src/lib/triage/exclusion/recovery.ts`); no scheduled wrapper. Route refuses every request if unset. |
| `TRIAGE_STORY_REBUILD_INTERNAL_TOKEN` | Shared secret for the operator-triggered Triage Story rebuild route (`src/lib/triage/story/rebuild.ts`); no scheduled wrapper. Route refuses every request if unset. |
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
| `schemas/review.version` | — | Semver of the REview release the SDL corresponds to (the `review` repo's release tag, not the embedded `review-web` crate version or a commit SHA) |
| `schemas/giganto.graphql` | Giganto (data store) | Per-service `status` / `config` / `updateConfig` for the Giganto external service, plus the Event-menu source-event browsing surface (network raw-event queries, `sensors`) |
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

The canonical version source is the `review` repo's release tag (e.g.
`0.49.0`). `review` is a release-only umbrella that pins
`review-database` and `review-web`; the GraphQL SDL is defined in the
embedded `review-web` crate, so the `review` release tag identifies
which `review-web` is in play, and dumping the SDL is purely a capture
mechanism rather than the version source.

1. Pick the target `review` release tag. Note the embedded `review-web`
   version from that release's notes (purely informational — the version
   recorded in `schemas/review.version` is the `review` release tag, not
   the `review-web` crate version).
2. Capture the SDL from the matching `review-web` source tree with the
   `auth-mtls` feature enabled, which is how aice-web-next talks to
   REview. There is no canonical SDL artifact yet; the pragmatic option
   today is to build `review-web` locally and dump the SDL, e.g.:

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
   `pub`. Once REview exposes a stable SDL artifact, this capture
   step can be simplified.
3. Replace `schemas/review.graphql` with the dumped SDL. Preserve the
   header comment, and refresh it to record both the `review` release
   tag (e.g. `review 0.49.0`) and the embedded `review-web` version
   (e.g. `review-web 0.32.0`) for traceability.
4. Write the `review` release tag (semver, e.g. `0.49.0`) into
   `schemas/review.version`. Do **not** write the `review-web` crate
   version or a commit SHA — the file records the umbrella release the
   SDL corresponds to.
5. Review `git diff schemas/` and update any code that references
   removed or renamed fields in the same PR.
6. Regenerate schema-derived TypeScript types:

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
7. Commit the schema, version file, and regenerated types together.
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
proxy handles TLS termination; the prod profile only publishes the
HTTPS listener on the host (see "Production" below).

### Production

The production nginx config (`infra/nginx/nginx.prod.conf`) enables:

- HSTS with a 1-year `max-age` and `includeSubDomains`
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`

The `nginx-prod` compose service publishes the container's TLS
listener (`:443`) on host port `9443` by default — i.e. the app is
reachable at `https://<host>:9443`. The non-standard port leaves
host `:443` free for an internet-facing peer (e.g. `aimer-web` in
the bridge handoff) on the same machine and avoids collisions on
host OSes that already bind `:80`. Operators who want the standard
`:443` (or to publish `:80` for an HTTP→HTTPS redirect handled by
the container's internal `listen 80` block) can re-publish via a
local `docker-compose.override.yml`. Note that the internal redirect
emits `https://$host$request_uri`, so reopening host `:80` without
also publishing host `:443` will land the redirect on a closed port.

**Migration note.** This default changed from `80:80, 443:443` to
`9443:443`. Operators relying on the previous default need to
update bookmarks and any reverse-proxy upstream from `:443` to
`:9443`, or pin the old mapping in their override.

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
promotes from Report-Only to enforcing.  `pnpm build` chains
`scripts/assert-no-static-html-routes.mjs`, which fails the build if
any HTML route is statically prerendered (the route map should mark
every HTML route as `ƒ` (dynamic)).  The Playwright suite at
`e2e/csp-nonce.spec.ts` is the matching regression net for the
nonce-on-every-`<script>` invariant under `pnpm dev`.

The `__Host-csrf` cookie and `Secure` flag on the access token cookie
are automatically enabled when `NODE_ENV=production` (set by the
Dockerfile).

#### Postgres host port and the dev/prod address split

The compose `postgres` service publishes its container port `5432` on the
host as `${AICE_POSTGRES_HOST_PORT:-5434}` so aice-web-next does not
collide with any other Postgres instance running on the same host (e.g.
bootroot's own Postgres for step-ca state). Two distinct addresses
result:

- **Host tooling (`psql`, DBeaver, ad-hoc `pg_dump`, CI jobs, the
  Vitest integration suite running outside the container):** connect to
  `localhost:${AICE_POSTGRES_HOST_PORT:-5434}`.
- **The compose `next-app` service:** connects internally over the
  compose network at `postgres:5432`. The container-internal port is
  unchanged.

**Breaking change for external clients on upgrade.** Any host-side
tooling that previously connected to `localhost:5432` (psql sessions,
DBeaver/TablePlus profiles, ad-hoc `pg_dump` scripts, CI jobs that bind
nothing but assume the published port) breaks after this version is
deployed until reconfigured to `5434`. Operators who need to keep the
previous behavior can override with
`AICE_POSTGRES_HOST_PORT=5432`. The shipped `.env.example` already uses
the new default.

#### Postgres init script and re-applying grants

The `infra/postgres/init-audit-db.sql` script is mounted into
`docker-entrypoint-initdb.d`, which Postgres only runs **on first volume
init**. Edits to the script after the volume already exists are ignored
by compose. To force the script to re-run at compose-init time, the
volume must be removed:

```bash
docker compose down -v
docker volume rm <project>_pgdata
```

The init script itself is now safe to run by hand against an existing
cluster:

```bash
psql -h localhost -p 5434 -U postgres -f infra/postgres/init-audit-db.sql
```

Both `CREATE DATABASE audit_db` and `CREATE ROLE audit_writer` are
guarded so re-runs are no-ops, not errors.

The runtime grant helper in `src/lib/db/migrate.ts`
(`ensureAuditRolePermissions{Preflight,Postflight}`) re-applies
`audit_writer` privileges on every boot, so operator-induced privilege
drift heals automatically without re-running the init script. The
preflight pass runs *before* `migrateAuditDb()` because the audit
migrations themselves need `CREATE` on `public`; the postflight pass
re-applies table and sequence grants once the migration has created the
audit table.

#### First-boot deployment checklist

1. Populate `.env` **starting from `.env.example.prod`** (the prod
   compose profile reads `.env`, not `.env.local`). The prod compose
   passes `.env` *directly into the `next-app` container*, so the
   database URLs must use the compose-network address `postgres:5432`,
   not the host-side `localhost:${AICE_POSTGRES_HOST_PORT:-5434}` that
   the dev-oriented `.env.example` ships with for `pnpm dev`.
   `.env.example.prod` already has the compose-network DSNs and leaves
   every required first-boot value as a visible blank with a comment,
   so the next-app container fails fast on missing values instead of
   silently booting without (e.g.) an initial administrator.

   ```bash
   cp .env.example.prod .env
   ```

   The boot-time env validator
   (`src/lib/instrumentation/env-validate.ts`) fires whenever
   `AICE_ENV_PROFILE=prod-compose` (the prod compose `next-app`
   service sets this for you) and rejects:
   - any of `DATABASE_URL`, `DATABASE_ADMIN_URL`,
     `AUDIT_DATABASE_URL` pointing at `localhost`, `127.0.0.1`, or
     `::1`. The error names the env var and points at
     `postgres:5432` — the symptom is otherwise a confusing
     connection-refused after migrations start.
   - `EXPECTED_ORIGIN` missing, or set to anything that is not an
     exact HTTP(S) origin (`http://` or `https://` scheme + host +
     optional port; no path / query / fragment). Without this,
     post-login mutating requests fail
     Origin validation in `withAuth` because the upstream sees
     `http://...` while the browser sent `https://...:9443`.

   Host tooling (`psql`, the Vitest integration suite, DBeaver, etc.)
   continues to use `.env.example` defaults at
   `localhost:${AICE_POSTGRES_HOST_PORT:-5434}` — a separate file
   (e.g. `.env.local`) is the natural place to keep them.

   At minimum also set `CSRF_SECRET`, the GraphQL endpoints, the
   initial admin credentials (the bootstrap aborts on first boot if
   both `INIT_ADMIN_USERNAME` and `INIT_ADMIN_PASSWORD` are blank and
   no Docker secret files are mounted), and:
   - `EXPECTED_ORIGIN=https://your.public.host:9443` so the
     CSRF/Origin guard accepts mutation requests through the HTTPS
     proxy. The `:9443` suffix matches the default `nginx-prod`
     host-port mapping (`9443:443`) — the browser sends the port in
     the `Origin` header, and any mismatch with `EXPECTED_ORIGIN`
     causes every state-changing request to be rejected. Drop the
     port suffix only when an external reverse proxy terminates TLS
     on standard `:443` (in which case the operator typically also
     publishes nginx-prod on host `:443` via override). The prod
     profile also needs `WEBAUTHN_RP_ORIGIN` set to that same full
     origin and `WEBAUTHN_RP_ID` set to its host
     (e.g. `WEBAUTHN_RP_ID=your.public.host`,
     `WEBAUTHN_RP_ORIGIN=https://your.public.host:9443`). The two
     env vars guard different code paths — the CSRF/Origin guard
     and the WebAuthn ceremony — but share the same value in this
     deployment. Leaving `WEBAUTHN_RP_ORIGIN` at its dev fallback
     silently breaks MFA enrollment on the prod profile.
   - One of `JWT_SIGNING_KEY_FILE=<path>` (recommended — a Secret
     mount) or `JWT_SIGNING_KEY_AUTOGEN=1` (single-instance dev
     convenience).
   - The prod nginx config sets `X-Request-ID` on every upstream
     request and includes `$request_id` in its access log. When an
     upstream load balancer already mints a request id, override
     the directive to forward `$http_x_request_id` instead so the
     id is end-to-end (see `infra/nginx/nginx.prod.conf`).
2. Make sure the persistent data volume is in place. The
   `docker-compose.yml` shipped here mounts a named `next-app-data`
   volume on `/app/data`; if you customise this, mount your own
   volume at `${DATA_DIR}` so the JWT key (and any other persisted
   state) survives container restarts.
3. `docker compose --profile prod up -d`.

If autogen is requested but `DATA_DIR` is not writable by the
container user (uid 1001), the app fails fast at startup with a
clear error message instead of crash-looping mid-boot.

#### mTLS upstream certificate mount

`review-web`, Giganto, and Tivan are all reached over mutual TLS.
The `next-app` container reads the client cert/key/CA from
`MTLS_CERT_PATH`, `MTLS_KEY_PATH`, and `MTLS_CA_PATH` (see
`src/lib/mtls.ts`); operators provide them by bind-mounting the
files into the container. The same shape is what the integration
test harness uses (`src/__integration__/global-setup.ts`).

Place the bind mount in a local `docker-compose.override.yml` —
**this file is not shipped** because operators typically already
keep their own override file, and committing a sample would
either collide with theirs or get accidentally tracked. Use the
shape below as a starting point:

```yaml
# docker-compose.override.yml (local; do NOT commit)
services:
  next-app:
    volumes:
      - /etc/aice/certs:/certs:ro
    environment:
      MTLS_CERT_PATH: /certs/client-cert.pem
      MTLS_KEY_PATH: /certs/client-key.pem
      MTLS_CA_PATH: /certs/ca.pem
```

The runtime user inside the container is `nextjs` (uid `1001`)
with primary group `nodejs` (gid `1001`) — see `Dockerfile`.
Files mounted into `/certs` must be readable by uid `1001`. For
the private key, recommend `0640` with group ownership matching
gid `1001`, or a POSIX ACL granting uid `1001` read access:

```bash
# Group-ownership variant
sudo chown root:1001 /etc/aice/certs/client-key.pem
sudo chmod 0640      /etc/aice/certs/client-key.pem

# ACL variant (preserves the host user's ownership)
sudo setfacl -m u:1001:r /etc/aice/certs/client-key.pem
```

Do **not** chmod the private key to `0644` (world-readable) just
to satisfy the container user — that exposes the key to every
other local account on the host. The cert and CA can be `0644`,
but the key must not be.

The mTLS hot-reload path re-reads all three files on `SIGHUP`
(`docs/en/operations/mtls-rotation.md`); the bind mount lets the
operator rotate the on-host file in place without rebuilding the
image.

#### Upstream FQDN resolution

The FQDN aice-web-next dials for each upstream **must match a
SAN on that upstream's server certificate**. REview's bootroot
service-add issues server certs whose SAN follows the
`<instance-id>.<service-name>.<hostname>.<domain>` shape; if the
hostname the app resolves disagrees with the SAN, the mTLS
handshake fails before any GraphQL request is sent. The same
FQDN must therefore be set as the host portion of
`REVIEW_GRAPHQL_ENDPOINT`, `GIGANTO_GRAPHQL_ENDPOINT`, and
`TIVAN_GRAPHQL_ENDPOINT`, and must resolve to the right address
in whichever environment the app runs.

Three deployment shapes:

- **Docker Desktop / Compose.** When the upstream lives on the
  Docker host (the common single-host bootroot case), add the
  SAN-matching FQDN to `extra_hosts` so the container resolves it
  to the host gateway:

  ```yaml
  # docker-compose.override.yml
  services:
    next-app:
      extra_hosts:
        - "review.<instance-id>.<hostname>.<domain>:host-gateway"
  ```

- **Kubernetes.** Use a CoreDNS `rewrite` rule that maps the
  bootroot-issued external FQDN onto the upstream's in-cluster
  `Service` DNS name:

  ```yaml
  # CoreDNS Corefile snippet
  rewrite name review.<instance-id>.<hostname>.<domain> review-web.aice.svc.cluster.local
  ```

  An alternative — naming a `Service` so its in-cluster DNS
  name equals the SAN — is **not** workable for the bootroot
  SAN shape: Kubernetes Service names are a single DNS label
  (no dots), while the bootroot SAN
  `<instance-id>.<service-name>.<hostname>.<domain>` is
  multi-label. CoreDNS rewrite is the supported path for
  bootroot-issued external FQDNs.

- **Bare-metal.** Add an `/etc/hosts` entry:

  ```text
  10.0.0.20  review.<instance-id>.<hostname>.<domain>
  ```

If the SAN and the resolved hostname disagree, you will see a
TLS handshake error in the Next.js logs (`certificate name does
not match`) and no GraphQL traffic will leave the app. Verify
both ends with `openssl s_client -connect ...` against the
upstream and `getent hosts ...` from inside the `next-app`
container.

#### Trusted-proxy CIDR

Single-origin deployments (one TLS-terminating nginx in front of
one `next-app`) do not need a trusted-proxy allow-list — the
CSRF/Origin guard is keyed off `EXPECTED_ORIGIN`, not the
client's transport address, so an attacker who cannot also forge
the browser's `Origin` header cannot bypass it. There is
deliberately no `TRUSTED_PROXIES` env var to set; if you go
looking for one, you won't find it. A separate trusted-proxy
allow-list (for forwarded-header trust at the BFF, distinct from
nginx's own `set_real_ip_from`) remains explicitly out of scope
for v1.

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
