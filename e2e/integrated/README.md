# Integrated e2e harness for analyze-bridge (#635)

The integrated suite exercises the cross-origin analyze-bridge Send flow
against a real multi-service stack: aice-web-next + aimer-web + aimer +
Keycloak + REview, all running on their actual cross-origin hostnames
behind real TLS. It runs across the supported browser matrix (Chromium,
Firefox, WebKit) to cover the popup-blocker surface from #629 §Tests.

This is the "named equivalent" of the `docker-compose.e2e.yml` suggested
in #635 — the reference setup is the multi-host OrbStack stack documented
in [`/Users/sehkone/projects/test-clumit/multi-host-resume.md`](../../../test-clumit/multi-host-resume.md).
Operators running their own compose stack should match the contract below.

## Run

```bash
pnpm e2e:integrated
```

Optional env overrides:

| Variable | Default | Notes |
| --- | --- | --- |
| `AICE_WEB_NEXT_URL` | `https://001.aice-web-next.aiceweb-host.test.local:9443` | aice-web-next public origin under test |
| `AIMER_WEB_URL` | `https://001.aimer-web.aimer-web-host.test.local:19443` | aimer-web public origin (form action target) |
| `INIT_ADMIN_USERNAME` / `INIT_ADMIN_PASSWORD` | `admin` / `Admin1234!` | aice-web-next admin |
| `KEYCLOAK_TEST_USERNAME` / `KEYCLOAK_TEST_PASSWORD` | `tester` / `Tester1234!` | Keycloak realm user for cold-OIDC scenario |
| `PLAYWRIGHT_WORKERS` | `1` | Increase only after seeding is parallel-safe |

## Stack contract

The harness assumes the operator's compose / multi-host setup provides:

### aice-web-next
- Production build behind HTTPS on `${AICE_WEB_NEXT_URL}`. Self-signed /
  internal-CA TLS is fine; the config sets `ignoreHTTPSErrors: true`.
- An admin account whose credentials match `INIT_ADMIN_USERNAME` /
  `INIT_ADMIN_PASSWORD`. `must_change_password` and `mfa_required` must
  be false for the admin (the harness does not handle policy gates).
- aimer integration configured: `aice_id`, `aimer_web_bridge_url`,
  `aimer_default_model_name`, `aimer_default_model`, and an active
  signing keypair (see `/api/aimer-integration/keypair/actions`).
- At least one customer row in the auth DB with `external_key` set —
  provisioned via the admin `POST /api/customers` route (the route
  creates the per-customer DB in the same transaction; raw SQL inserts
  skip provisioning and crash `runStartupMigrations()` on the next
  boot). See `seed/seed-aice-customer.sh`.
- The customer's `id` must match the id REview returns for the same
  customer name via `event.origCustomer`. On a fresh aice-web-next +
  the reference dump (`Customer A` at REview id=1), reset the
  customers sequence to 1 before running the seed script.
- At least one REview event whose detail page surfaces an `<AimerBanner>`
  with that customer in `candidates`. Pick an event whose
  `src/lib/detection/queries.ts` GraphQL fragment requests
  `origCustomer { id name }` (e.g. `BlocklistConn`,
  `DnsCovertChannel`) — some event types like
  `DomainGenerationAlgorithm` omit it, so their banner stays
  `noCandidates`.

### aimer-web
- Production build behind HTTPS on `${AIMER_WEB_URL}`. `EXPECTED_ORIGIN`
  set to the same URL so OIDC redirect_uri uses the canonical public
  origin (per aimer-web#279, merged 2026-05-22).
- `trust_registry` row matching aice-web-next's `kid` (so
  `verifyAnalyzeParamsToken` resolves the signing key).
- Postgres reachable for cached-path verification (`pending_analysis_requests`
  and `event_analysis_result` row inspection).

### Keycloak
- Realm `aimer` imported (clients `aimer-web`, `aimer-web-admin`).
- Realm `redirectUris` includes `${AIMER_WEB_URL}/api/auth/callback`.
- A test user matching `KEYCLOAK_TEST_USERNAME` / `KEYCLOAK_TEST_PASSWORD`
  whose first-login flow does not force password reset or MFA enrollment.
- `KC_HOSTNAME` matches the public origin so OIDC discovery returns
  browser-reachable URLs.

### aimer (LLM analyzer)
- Real or stub aimer reachable from aimer-web's `runAnalyzeFlow`. A
  fixed-output stub is recommended (per #635 "Decisions to settle" §aimer)
  so the cold-path scenario completes deterministically.

### REview
- The mint endpoint reads one event via REview's GraphQL `event(id:)`
  query under `customerIds: [customerId]`. The reference setup uses a
  real REview restored from a fixtures dump (`/dump/manager`).
- A `Customer` registered with networks covering the dump's address
  space — REview's `event.origCustomer` resolver matches the event's
  `origAddr` against each customer's `networks` (CIDRs) at query time,
  so retroactive provisioning is enough. See
  `seed/seed-review-customer.mjs`. The seeded REview customer name +
  id must align with the aice-web-next customer row (so the same id
  flows through `extractAimerCustomerCandidates`).

## DNS

Both hostnames must resolve from the host running Playwright. For the
reference OrbStack setup, that means the macOS host running
`pnpm e2e:integrated` needs `/etc/hosts` entries pointing the two FQDNs
at the M1 / M3 OrbStack VM IPs. See the resume guide §"Hostname
해상도" for an example.

## Scenario status

| Scenario | Status | Tracking |
| --- | --- | --- |
| harness smoke (storageState reach) | implemented | — |
| cold OIDC happy path | `test.fixme` | needs Keycloak test user; banner enablement verified manually on Blocklist events after running both seed scripts |
| cached SSO happy path | `test.fixme` | needs the cold scenario green first |
| cross-binding tamper × 3 | `test.fixme` | needs the network interceptor helper that mutates the multipart body before it leaves the page |

Each `test.fixme` carries an inline TODO with the exact missing seed.
Lift the marker when the dependency lands.

## Seed scripts

The two scripts under `seed/` cover the customer-side prerequisites:

```bash
# 1. Reset the aice-web-next customer sequence so the next insert lands at id=1
orb -m m1 docker exec aice-web-next-postgres-1 \
  psql -U postgres -d auth_db -c "SELECT setval('customers_id_seq', 1, false)"

# 2. Register a customer in REview with networks covering the dump's CIDRs
orb -m m1 docker cp e2e/integrated/seed/seed-review-customer.mjs \
  aice-web-next-next-app-1:/tmp/seed.mjs
orb -m m1 docker exec aice-web-next-next-app-1 node /tmp/seed.mjs

# 3. Provision the matching aice-web-next customer (admin API → per-customer DB)
e2e/integrated/seed/seed-aice-customer.sh
```

The reference manager dump carries `Customer A` at REview id=1, so the
default values in both scripts line up out of the box. Override via
`SEED_CUSTOMER_NAME` / `SEED_CUSTOMER_EXTERNAL_KEY` when running
against a non-default dump.

## Out of scope

See #635 §"Out of scope" — aimer-web-side coverage lives in aimer-web's
own CI; Phase 1/2 surfaces are tracked in #444 / #574.
