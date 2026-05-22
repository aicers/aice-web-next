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
- At least one customer row in the auth DB with `external_key` set.
- At least one REview event whose detail page surfaces an `<AimerBanner>`
  with that customer in `candidates` and `customerBridgeEligible[id]=true`.

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

## DNS

Both hostnames must resolve from the host running Playwright. For the
reference OrbStack setup, that means the macOS host running
`pnpm e2e:integrated` needs `/etc/hosts` entries pointing the two FQDNs
at the M1 / M3 OrbStack VM IPs. See the resume guide §"Hostname
해상도" for an example.

## Scenario status

| Scenario | Status | Tracking |
| --- | --- | --- |
| harness smoke (admin sign-in) | implemented | — |
| cold OIDC happy path | `test.fixme` | needs event + Keycloak user seeding |
| cached SSO happy path | `test.fixme` | needs the cold scenario green first |
| cross-binding tamper × 3 | `test.fixme` | needs the network interceptor helper |

Each `test.fixme` carries an inline TODO with the exact missing seed.
Lift the marker when the dependency lands.

## Out of scope

See #635 §"Out of scope" — aimer-web-side coverage lives in aimer-web's
own CI; Phase 1/2 surfaces are tracked in #444 / #574.
