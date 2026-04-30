# Manual Authoring Guide

This guide defines the principles and conventions for writing and
maintaining the AICE Web user manual. All manual authors — human and
AI agent alike — must follow these rules.

## When to write documentation

- **Do not write** manual content for a feature that is still under
  active development and whose UI or behavior is expected to change
  significantly. Writing documentation for an unstable feature wastes
  effort.
- **Do write** manual content as soon as the feature implementation
  is complete. A feature is not done until its manual page exists.
- **Keep the manual in sync with code.** Whenever code changes affect
  user-facing behavior or UI, the corresponding manual pages must be
  updated in the same PR or immediately after. If a feature is
  removed, the manual page must be removed or updated.

## Content requirements

### UI screenshots are mandatory

Every feature description must include actual UI screenshots. Text
alone is not sufficient. Screenshots help readers who are not yet
familiar with the interface.

- Place screenshots in `docs/assets/`.
- Use PNG for screenshots, SVG for diagrams.
- Use relative paths from the Markdown file
  (e.g., `![dialog](../assets/account-create.png)`).
- Update screenshots whenever the UI changes.

### Screenshot exception for infrastructure-gated features

A narrow exception applies when a feature's UI cannot be rendered
in the authoring worktree because it depends on external
infrastructure the worktree has no access to (for example, a
back-end service that is not open-sourced yet, or a live event
store with real data). In that case the feature page may ship
an SVG wireframe stand-in instead of a PNG capture, provided
that:

- The wireframe is placed in `docs/assets/` alongside the
  would-be PNG, using the matching filename with an `.svg`
  suffix (e.g., `event-investigation-en.svg`).
- EN and KO pages each carry their own localized wireframe so
  language parity is preserved.
- The page body explicitly tags the figure as a wireframe
  stand-in and points to the follow-up that will replace it
  with a real capture once staging is available.
- The PR description's "Not addressed" or equivalent section
  records the screenshot debt so the follow-up is not lost.

This exception is intended for phase PRs that land before
their depended-on infrastructure. It is not a general waiver:
once staging is available, the wireframe must be replaced with
an actual screenshot as a follow-up.

#### Detection: exception ended

The Detection feature no longer qualifies for this exception.
A reproducible local-REview setup is documented under
[Live REview screenshot procedure](#live-review-screenshot-procedure)
below, so every Detection PR — including new feature work and
follow-ups to existing pages — must ship real PNG captures from
the start. The lone remaining wireframes under
`docs/assets/detection-tab-bar-{en,ko}.svg` belong to the multi-
tab feature whose successor PR has not yet landed; once it does,
those wireframes must be replaced as part of the same PR rather
than punted to a follow-up.

## Live REview screenshot procedure

**When to use this procedure.** Follow it only when a capture
needs **large-volume REview data** that a hand-rolled mock cannot
plausibly stand in for — for example, the Detection result list
with thousands of events powering the paginator's `Page X of Y`
totals, the Quick peek inspector populated from real subtype
fields, or the CSV-export large-row guardrail. Captures whose
shape is fully determined by client-side state (an empty filter
drawer, a confirmation dialog, a settings form) do **not**
require a live REview — point the BFF at a mocked GraphQL
endpoint instead and capture from there.

The following steps are the minimum needed to render a page
against representative live data so a contributor can produce
parity-compliant EN / KO captures without staging access. The
procedure was piloted on Detection (issue #335); the same
sequence applies to any feature page that surfaces large-volume
REview data.

> **Always start a fresh REview for the capture session.** Do
> **not** point the BFF at a REview that is already running for
> some other purpose (a teammate's debugging instance, an
> always-on developer service, the previous capture run). Reusing
> a live instance risks polluting its state with the screenshot
> session — and, conversely, leaves your captures at the mercy of
> whatever filter / data the other process is mutating in the
> background. Spin up a dedicated `review` process pinned to the
> worktree's `data/review/` and `data/review.toml`, take the
> captures, and shut it down when done.

> **Dataset location is not assumed.** This guide does **not**
> name a canonical path for the large-volume REview test dataset
> — its location is a per-contributor / per-environment detail
> that the issue or PR briefing must communicate explicitly to
> whoever is running the capture (e.g. "copy the dataset from
> `~/projects/test-clumit/data/review` into the worktree's
> `data/review/`"). When you open an issue that requires this
> procedure, include the dataset path; when you pick up an issue
> that requires it, ask for the path before you start.

### Local REview setup

1. Stand up a local REview build (auth-mtls feature) somewhere on
   your machine. The procedure that follows assumes you have a
   working `review` binary and a dataset directory with
   `VERSION`, `classifiers/`, `pretrained/`, and `states.db`
   files (the "REview test dataset"). The dataset's source path
   is supplied out-of-band — see the note above; copy it into the
   worktree (next step) rather than running REview directly out
   of the source location, so the capture session never mutates
   the upstream copy.
2. Generate a development CA and two leaf certs in the worktree:
   - `data/dev-tls/ca-cert.pem` + `data/dev-tls/ca-key.pem`
     (signing CA, valid for at least 30 days).
   - `data/dev-tls/review-cert.pem` + `data/dev-tls/review-key.pem`
     for REview's TLS listener; sign with the dev CA, set CN to
     `localhost`, and include
     `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1`
     plus `extendedKeyUsage=serverAuth,clientAuth`.
   - `data/dev-tls/aice-web-next-cert.pem` +
     `data/dev-tls/aice-web-next-key.pem` for the BFF; sign with
     the dev CA, set CN to `aice-web-next`, and include
     `subjectAltName=DNS:001.aice-web-next.<host>.<domain>`
     (REview's `validate_client_cert` requires four-part DNS SAN
     with `aice-web-next` as the second part) plus
     `extendedKeyUsage=clientAuth,serverAuth`.

   > **Don't reuse production-style certs whose server SAN is
   > only the four-part DNS** (e.g. `001.review.review-host.test.local`
   > with no `localhost` SAN). The BFF connects to
   > `https://localhost:8443/graphql` per the `.env.local` template
   > below, so the TLS handshake checks `localhost` against the
   > server cert's SAN — a four-part-DNS-only cert will fail
   > hostname verification. If you must reuse such certs (e.g.
   > a shared Bootroot test bundle), regenerate the server leaf
   > with a `DNS:localhost` SAN added, or add the four-part DNS
   > to `/etc/hosts` (`127.0.0.1 001.review.review-host.test.local`)
   > and point `REVIEW_GRAPHQL_ENDPOINT` at the four-part name.
   > The fresh `data/dev-tls/review-cert.pem` recipe above sidesteps
   > the issue entirely.
3. Copy the REview dataset into `data/review/` so the database
   files live under the worktree, and create a `data/review.toml`
   that pins:

    ```toml
    data_dir = "data/review"
    backup_dir = "data/review-backup"
    htdocs_dir = "data/review-htdocs"
    graphql_srv_addr = "127.0.0.1:8443"
    rpc_srv_addr = "127.0.0.1:38390"
    hostname = "localhost"
    cert = "data/dev-tls/review-cert.pem"
    key = "data/dev-tls/review-key.pem"
    ca_certs = ["data/dev-tls/ca-cert.pem"]
    syslog_tx = false
    pen = 0
    ```

4. Start REview with the local-auth bypass disabled so it
   validates the BFF's mTLS + JWT auth chain even from
   `127.0.0.1`:

    ```bash
    REVIEW_WEB_DISABLE_LOCAL_AUTH_BYPASS=1 \
      <path-to>/review data/review.toml
    ```

5. Confirm REview is up by hitting its GraphQL with the dev
   client cert (Bearer header omitted is OK for the introspection
   ping; production queries require a JWT). The endpoint should
   answer `{"data":{"__typename":"Query"}}`.

### Next.js manual-author environment

1. In `.env.local`, point the BFF at the local REview and the
   dev cert pair:

    ```text
    REVIEW_GRAPHQL_ENDPOINT=https://localhost:8443/graphql
    MTLS_CERT_PATH=<absolute>/data/dev-tls/aice-web-next-cert.pem
    MTLS_KEY_PATH=<absolute>/data/dev-tls/aice-web-next-key.pem
    MTLS_CA_PATH=<absolute>/data/dev-tls/ca-cert.pem
    ```

2. Make sure the local Postgres has `auth_db`, `audit_db`, and
   the customer database referenced by your seeded customer
   (`default_db` is the convention used during the issue #335
   pilot). At least one row in `customers` is required —
   `resolveEffectiveCustomerIds` rejects empty scopes — and the
   `admin` account must be exempt from MFA enrollment for an
   uninterrupted screenshot flow:

    ```sql
    INSERT INTO customers (name, description, database_name, status)
      VALUES ('Default', 'Local dev tenant', 'default_db', 'active');
    UPDATE accounts SET mfa_override = 'exempt'
      WHERE username = 'admin';
    ```

3. Run `pnpm dev` and sign in as the admin you provisioned via
   `INIT_ADMIN_USERNAME` / `INIT_ADMIN_PASSWORD`.

### Locale switching

The manual is bilingual, so EN and KO captures must match. With
`localePrefix: "as-needed"`, EN renders at `/detection` and KO at
`/ko/detection`. Render each variant in the same browser session
(viewport, theme, drawer state, and selected event identical
across both) and capture pairs back-to-back so any drift in the
underlying data is shared between the two figures.

### Viewport and theme

Detection captures use a **1440×900 desktop viewport** in **dark
mode**. Set `localStorage.theme = "gray-dark"` before the first
render so the chrome is dark from frame zero. Every PNG must use
the same dimensions so figures line up across pages.

### Filename convention

`<feature>-<section>-<locale>.png`. For Detection that yields
stems like `detection-pagination-en.png`,
`detection-quick-peek-ko.png`, etc. The same convention applies
to other features that pass through this procedure — pick a
short, stable feature slug and reuse it across every section
capture for that page.

### Caption guidelines

Use a short, neutral caption matching the figure
(`![Detection page](../assets/detection-en.png)`). Do **not**
flag a real capture as a wireframe stand-in or reference the
infrastructure-gated exception above; that note belongs only to
figures that genuinely lack a captureable backend.

### Verification checklist

Before opening a Detection PR with new screenshots:

- [ ] EN and KO PNGs exist for every figure the page references,
      with matching filenames and equivalent captured state.
- [ ] Each PNG was captured at 1440×900, dark theme, against the
      local-REview procedure above.
- [ ] No personally identifiable information, no developer
      machine artefacts (open IDE windows in the background,
      personal browser bookmarks, etc.) appear in any frame.
- [ ] `mkdocs build --strict` passes with no warnings or broken
      links.

### Automation reference

A reusable Playwright harness lives at
`docs/scripts/capture-detection-screenshots.mjs`. It is
Detection-specific today but is the canonical example to copy
when adding a sibling capture script for another feature that
needs this procedure. Sibling scripts belong under the same
`docs/scripts/` directory so that adding or updating one keeps
the change docs-only as far as CI's paths filter is concerned.
It logs in, sets dark theme, walks each of the captures listed
above, and writes the resulting PNGs into `docs/assets/`. Use it
as a starting point when adding new Detection sections; the
script's locale-aware selectors are the canonical source of
truth for which strings drive the capture flow.

### Language parity

- Every page in `docs/en/` must have a corresponding page in
  `docs/ko/` (and vice versa).
- Section structure and heading hierarchy must match between
  languages.
- Keep the same filename across language directories.

## Customer scope (multi-tenancy contract)

Code that touches customer data must enforce tenant isolation —
data, audit rows, and even the shape of error messages must not
leak across customer boundaries. The contract below pins the rules
for new code and the regression guards installed under issue #388
(static dispatch-context guard, integration test matrix).

### Project principle

A caller's effective customer scope is whatever
`resolveEffectiveCustomerIds(accountId, roles)` returns. No code
path that handles customer-touching data may bypass it except
through one of the three permitted patterns below. "Empty scope"
is a hard fail for non-`access-all` callers — never silently widen
to "all customers".

### Permitted patterns

There are exactly three permitted ways for new code to issue a
customer-scoped operation:

1. **Dispatch via `buildDispatchContext(session)`** — for any code
   path that crosses the BFF boundary into REview / Giganto / Tivan
   over GraphQL. Both the Node track
   (`src/lib/node/dispatch-context.ts`) and the Detection track
   (locally declared in `src/lib/detection/server-actions.ts`) use
   this helper to materialize the caller's scope into a concrete
   `customer_ids: number[]` list before signing the Context JWT.
   review-web reads scope from the JWT verbatim; do not pass scope
   in the GraphQL filter or rely on review-web to re-derive it.

2. **Local DB query with an `account_customer` JOIN** — for
   queries that read directly from `auth_db` / `audit_db`. Either
   add `JOIN account_customer ac ON ac.customer_id = <table>.customer_id
   AND ac.account_id = $session_account` for the account-link
   pattern, or push an explicit `customer_id IN (...)` predicate
   sourced from `resolveEffectiveCustomerIds`. The audit-log viewer
   route (`src/app/api/audit-logs/route.ts`) is the canonical
   example after #386.

3. **Explicit `customers:access-all` permission check** — when a
   route legitimately needs to bypass tenant scope (e.g. a
   System Administrator-only listing of every customer). Always
   branch on `await hasPermission(session.roles, "customers:access-all")`
   and never on the audit-only `role[0]` string. Customer scope
   checks must NOT be inferred from the role name.

### Audit log contract

Every `auditLog.record(...)` call that describes an event tied to
a specific customer must populate the top-level `customerId` field
with the relevant customer id (not just place it inside `details`).
Without it the row is invisible to the audit-log viewer's
`customer_id IN (...)` predicate, so the tenant operator who owns
the resource never sees it. Customer-agnostic events
(`account.login`, system events) carry `customerId: null`; admin
sees those rows, restricted callers do not.

### Error-message contract

When an error message references a customer identifier the caller
may not have scope on, redact it before surfacing. Use
`formatScopedError({ template, references }, allowedCustomerIds)`
from `src/lib/auth/scope-redaction.ts` (or its positional alias
`redactForScope(template, references, allowedCustomerIds)`). Each
interpolated identifier is declared as a structured `Reference`
carrying its kind (`customer` / `sensor` / `address`) and the
customer it belongs to; the helper substitutes the literal value
when the caller has scope and replaces it with a generic stand-in
(`[redacted customer]`, etc.) otherwise:

```ts
return formatScopedError(
  {
    template: 'Customer "{customer}" not found',
    references: [
      { kind: "customer", id, placeholder: "customer", literal: name },
    ],
  },
  allowedCustomerIds,
);
```

Out-of-scope resources should return `404` (not `403`) — anything
else discloses existence. Internal logs may name the id; the
response body must not.

### Static dispatch-context guard (`pnpm check:scope`)

A Node script at `scripts/check-dispatch-context.mjs` runs in CI
alongside `pnpm check`. It enforces, file-by-file:

- Only files under `src/lib/node/`, `src/lib/detection/`, and the
  GraphQL client modules themselves may call `graphqlRequest` /
  `graphqlRequestTo`. Any other call site fails CI.
- For each allowlisted file that calls one of the helpers,
  `buildDispatchContext` must either be imported from another
  module or declared locally as a top-level function / const.
  Files that have neither fail CI.

Both `pnpm check` (Biome) and `pnpm check:scope` must pass before
a PR can land. The guard is intentionally simple — it does not
verify that the dispatch context flows into the specific call
site, only that the symbol is in scope. Deeper correctness still
relies on code review.

To allow a deliberate exception, append a same-line comment to
the offending call:

```ts
return graphqlRequest(QUERY, undefined, ctx); // scope-allowlist: <reason>
```

The reason must be non-empty and survives review precisely
because it is loud. Use the override only when the call genuinely
does not need a customer scope (e.g. a non-customer-scoped manager
introspection query); never to silence a real violation.

### Cross-customer integration test matrix

`src/__integration__/multi-tenancy/scope.test.ts` is a
data-driven regression suite that exercises every customer-scoped
endpoint against three personas: `account-A`, `account-B`, and
`admin`. Every row in the `ENDPOINTS` array runs the standard
assertions for its `expects` mode:

- `list-scoped` — account-A's list contains the customer-A fixture
  row and excludes the customer-B row; account-B mirrors that on
  customer B; admin sees both plus any null-customer fixture rows.
  When the row payload exposes a single `customer_id` field the
  harness also asserts every row matches the caller's customer; rows
  that don't expose one (e.g. accounts list — membership is N:N via
  `account_customer`) skip the per-row check via
  `rowCustomerId: () => undefined`.
- `200-on-in-scope-404-on-out-of-scope` — account-A's GET on
  customer A returns 200; account-A's GET on customer B returns
  404 (NOT 403 — surfacing 403 would disclose existence); admin gets
  200 on both.
- `mutation-scope` (POST / PATCH / DELETE) — for each persona the row
  declares an in-scope and out-of-scope variant of the request body
  / path; the harness fires both and asserts the declared
  `expectStatus` (typically 2xx in-scope, 403 out-of-scope for non-
  admins; 2xx for both for admin). An optional
  `cleanupAfterSuccess` hook resets fixture state between mutation
  rows so the matrix can run repeatedly against a long-lived dev
  database.
- `admin-only` — account-A and account-B are rejected (default
  `nonAdminStatuses: [401, 403]`); admin succeeds with the row's
  declared `adminSuccessStatus`.

**Adding a new customer-scoped endpoint is a one-line change** to
`ENDPOINTS`. Pick the appropriate `expects` mode, fill in the
`name`, `method`, and the mode-specific fields (`path` for
`list-scoped`, `pathFor` for detail GETs, `request` for mutations
and admin-only routes), and the harness iterates and asserts
automatically. If the new endpoint needs a fixture row that is not
in `Resources`, extend `Resources` and the `beforeAll` seeder;
otherwise the row alone is enough.

Routes that go through `buildDispatchContext` (the node /
detection API surface backed by REview / Tivan over GraphQL) are
**not** in this matrix — the cross-customer contract there is
"the dispatch JWT carries the right `customer_ids`", which is a
structural assertion against the dispatch context rather than a
row-level DB scope check. Those routes are guarded by
`pnpm check:scope` (the static dispatch-context guard above) and
exercised against the `mock-graphql` helper in their feature-
specific integration files.

The matrix is the regression-test target for both #386 (audit-log
viewer scoping) and #387 (the hardening sweep). New PRs that
touch a customer-scoped local-DB route should add their endpoint
to `ENDPOINTS` rather than copying an existing per-endpoint test
file.

## Markdown formatting

- Use **ATX headings** (`#`, `##`, `###`). Do not skip heading
  levels.
- Leave a **blank line** before and after headings, lists, code
  blocks, and tables.
- Indent nested list items with **4 spaces**.
- Limit list nesting to **3 levels**. If deeper nesting is needed,
  restructure into sub-sections.
- Wrap prose lines at **80 characters** for readability in diffs.
  (Tables and URLs may exceed this limit.)

## AI agent authoring

Manual content is authored by AI agents. This means:

- Write in a straightforward, consistent style that agents can
  maintain reliably.
- When creating an issue for a feature, include a task item for
  manual documentation so the agent picks it up.
- Follow all rules in this guide. The key rules are also in
  `AGENTS.md` and `CLAUDE.md` for automatic enforcement.

## Local preview

```bash
# Install dependencies (one-time)
python3 -m pip install mkdocs-material mkdocs-static-i18n mkdocs-with-pdf

# Start the dev server
mkdocs serve
```

Open <http://localhost:8000> to see the English manual.
Switch to Korean via the language selector in the header.

## Build

```bash
mkdocs build --strict
```

The static site is generated in `site/`.

## PDF generation

```bash
./scripts/build-docs-pdf.sh en
./scripts/build-docs-pdf.sh ko
```

PDFs are written to `site/pdf/aice-web-manual.{en,ko}.pdf`.

## MkDocs tooling maintenance

The manual is built with MkDocs 1.6.x + Material for MkDocs 9.x +
mkdocs-static-i18n.

### Known risks

- **MkDocs 2.0**: Not yet released, but the Material team has
  announced it will be incompatible with Material for MkDocs (plugin
  system removal, theme rendering changes, YAML to TOML config
  migration).
- **MkDocs 1.x maintenance**: The MkDocs project has been largely
  unmaintained since August 2024.
- **Zensical**: The Material team is building a ground-up replacement
  (Rust + Python, MIT license). It reads `mkdocs.yml` natively, so
  migration cost is expected to be low. As of March 2026 it is
  v0.0.28 — not production-ready.

### When to reassess

- Material for MkDocs drops MkDocs 1.x support (committed until
  November 2026).
- Zensical reaches 1.0 with feature parity.
- Any dependency becomes unmaintained or has unpatched security
  issues.

When reassessing, check:

1. Does `mkdocs build --strict` still pass?
2. Do the i18n plugin and PDF generation still work?
3. Is the GitHub Actions workflow compatible with the new versions?
4. Are there breaking changes in config format or plugin API?

See Discussion #178 for the full rationale.

## CI behavior for docs-only changes

The CI workflow (`.github/workflows/ci.yml`) uses `dorny/paths-filter`
to detect docs-only changes. When a commit modifies only documentation
files (`docs/`, `decisions/`, `**/*.md`, `mkdocs.yml`,
`.markdownlint*`), build, test, nginx-config, and other code-related
jobs are skipped. Only the change-filter job itself runs.

This means docs-only PRs merge faster and do not consume CI resources
for unrelated checks. If your PR includes both code and docs changes,
all CI jobs run as usual.

## Docs PR checklist

Before submitting a docs PR, verify:

- [ ] `mkdocs build --strict` passes with no warnings
- [ ] Local preview (`mkdocs serve`) renders correctly
- [ ] EN/KR pages are in sync (same structure, same filenames)
- [ ] New pages are listed in `mkdocs.yml` nav for both languages
- [ ] No broken links or missing images
- [ ] UI screenshots are included for new or changed features
