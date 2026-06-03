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

### UI screenshots

Feature descriptions should include UI screenshots. Text alone is
usually not sufficient — screenshots help readers who are not yet
familiar with the interface. How to source a figure depends on whether
the feature shows real data received from REview:

- **No REview data needed**: capture a real screenshot. Surfaces whose
  appearance is fully determined by client-side state — an empty filter
  drawer, a confirmation dialog, a settings form, a customer picker —
  are reproducible from the authoring worktree, so a real PNG is always
  expected.
- **Shows real data received from REview**: record a placeholder
  instead of a screenshot. Do not fabricate or hand-process the data,
  and do not stand up a one-off live REview just to capture a figure no
  one else can reproduce. A clearly labeled placeholder is more honest
  than a doctored or unreproducible capture. See
  [Screenshot exception for infrastructure-gated features](#screenshot-exception-for-infrastructure-gated-features)
  for how to ship one.

- Place figures in `docs/assets/`.
- Use PNG for real screenshots, SVG for diagrams and placeholders.
- Use relative paths from the Markdown file
  (e.g., `![dialog](../assets/account-create.png)`).
- Update figures whenever the UI changes.

### Screenshot exception for infrastructure-gated features

A feature page ships an **SVG wireframe stand-in** instead of a PNG
capture whenever its UI cannot be rendered against reproducible data
in the authoring worktree — most commonly because it shows real data
received from REview, but also when it depends on a back-end service
that is not open-sourced yet or a live event store the worktree has no
access to. A stand-in must satisfy:

- The wireframe is placed in `docs/assets/` alongside the would-be PNG,
  using the matching filename with an `.svg` suffix
  (e.g., `feature-state-en.svg`).
- EN and KO pages each carry their own localized wireframe so language
  parity is preserved.
- The page body explicitly tags the figure as a wireframe stand-in so
  readers know it is not a real capture.

For figures that show **real data received from REview**, the
placeholder is the standing form — not a temporary debt. There is no
"capture it for real later" step, because real REview data is
deliberately kept out of the manual: a live REview build is not
reproducible across contributors, and a screenshot taken against
fabricated or hand-processed data is misleading. Do not stand up a
live REview to replace these wireframes.

For figures gated only on infrastructure that will become available
later (for example a back-end service not yet open-sourced), the
wireframe is temporary instead: record the screenshot debt in the PR
description's "Not addressed" or equivalent section, and replace the
wireframe with a real capture once that infrastructure is available.

## Capturing screenshots

The conventions below apply to the **real screenshots** in the first
tier above — client-side surfaces that do not depend on REview data
(an empty filter drawer, a confirmation dialog, a settings form, a
customer picker, and the like). They were piloted on Detection
(issue #335) and apply to any feature page.

Because figures that show real data received from REview are
placeholders by policy (see [UI screenshots](#ui-screenshots)), no
live REview build, dataset, or mTLS setup is needed to author the
manual. When a surface needs *some* response to render at all, point
the BFF at a mocked GraphQL endpoint and capture the deterministic,
client-side chrome from there.

### Locale switching

The manual is bilingual, so EN and KO captures must match. With
`localePrefix: "as-needed"`, EN renders at `/detection` and KO at
`/ko/detection`. Render each variant in the same browser session
(viewport, theme, and drawer state identical across both) and
capture pairs back-to-back so the two figures stay consistent.

### Viewport and theme

Detection captures use a **1440×900 desktop viewport** in **dark
mode**. Set `localStorage.theme = "gray-dark"` before the first
render so the chrome is dark from frame zero. Full-page and
full-surface captures keep that shared viewport; tightly focused
component figures (for example the left-rail close-ups) may crop
to the relevant region after the page is rendered in that
viewport.

For Detection docs, dark mode is mandatory rather than a stylistic
preference. Reviewers should treat a light-mode Detection capture
the same way they would treat a missing screenshot: the docs are
not ready to merge until the figure is re-captured in dark mode.

### Filename convention

`<feature>-<section>-<locale>` — `.png` for real screenshots and
`.svg` for placeholder wireframes. For Detection that yields stems
like `detection-drawer-en.png` (a real client-side capture) or
`detection-analytics-en.svg` (a REview-backed placeholder). The same
convention applies to other features — pick a short, stable feature
slug and reuse it across every section figure for that page.

### Caption guidelines

Use a short, neutral caption matching the figure
(`![Detection drawer](../assets/detection-drawer-en.png)`). Do **not**
flag a real client-side capture as a wireframe stand-in or reference
the infrastructure-gated exception above; that note belongs only to
placeholders for figures that show real data received from REview (or
otherwise lack a captureable backend).

### Verification checklist

Before opening a PR with new or changed figures:

- [ ] EN and KO files exist for every figure the page references, with
      matching filenames and equivalent captured / illustrated state.
- [ ] Real screenshots were captured at 1440×900 in dark theme from
      the local mocked flow; figures that show real data received from
      REview use SVG placeholders instead (see [UI screenshots](#ui-screenshots)).
- [ ] No personally identifiable information, no developer
      machine artefacts (open IDE windows in the background,
      personal browser bookmarks, etc.) appear in any frame.
- [ ] `mkdocs build --strict` passes with no warnings or broken
      links.

### Automation reference

The maintained Detection capture flow for deterministic,
client-rendered surfaces (drawer, customer picker, save dialog, and
the like) lives in `e2e/detection-screenshots.spec.ts`. Run it with:

```sh
DETECTION_MANUAL_CAPTURE_ONLY=1 \
pnpm exec playwright test --config=e2e/playwright.config.ts \
  e2e/detection-screenshots.spec.ts
```

That environment flag swaps Playwright into a dedicated capture-only
project graph so the command above does not fan out into the rest of
the E2E matrix.

REview-backed surfaces (the list, analytics, Quick peek, CSV export,
pivot, and Event Investigation figures) are placeholders by policy, so
there is no real-data capture spec to run for them.

The older one-off scripts under `docs/scripts/` remain as
historical references, but they are no longer the canonical
capture path.

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

Every `auditLog.record(...)` call whose `target` is a record with a
**canonical, single customer id** (a customer, a node, a sensor, an
`account_customer` link row — anything where the customer that owns
the row is unambiguous) must populate the top-level `customerId`
field with that id (not just place it inside `details`). Without it
the row is invisible to the audit-log viewer's
`customer_id IN (...)` predicate, so the tenant operator who owns
the resource never sees it.

Two categories explicitly fall outside that rule and intentionally
record `customerId: null`:

- **Customer-agnostic events** — `account.login`, system events
  (system-settings, role mutations), MFA-credential management on
  the actor's own account. These have no customer dimension at all.
  Admin sees those rows; restricted callers do not.
- **Account-targeted mutations on N:N accounts** — `password.reset`,
  `account.unlock`, `account.restore`, `account.mfa.reset`,
  `account.update`, `account.delete`. The `target` is an account,
  and accounts relate to customers many-to-many through
  `account_customer` (see `getAccountCustomerIds` in
  `src/lib/auth/account-management.ts`). There is no single
  customer id to attribute the event to, and silently picking one
  member of the set would mislead viewers in the other tenants.
  These rows are therefore visible to admin only today; widening
  visibility for in-scope tenant operators on these events would
  require either a row-fan-out (one audit row per linked customer)
  or a multi-valued audit schema, both of which are out of scope
  for #388 and #387 and are tracked separately.

When a future audit row's target *is* unambiguously bound to one
customer (e.g. a route that operates on `account_customer (account,
customer)` together, or on a node/sensor whose `customer_id` is a
column on the row), follow the rule above and populate
`customerId`. The canonical examples are
`src/app/api/customers/[id]/route.ts` (target = a customer),
`src/app/api/accounts/[id]/customers/route.ts` (target = the
`account_customer` link being created — the customer dimension is
in the URL), and `src/app/api/nodes/[id]/route.ts` (target = a node
whose `customer_id` is a column).

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

- Only files under `src/lib/node/`, `src/lib/detection/`,
  `src/lib/triage/`, and the GraphQL client modules themselves may
  call `graphqlRequest` / `graphqlRequestTo`. Any other call site
  fails CI.
- For each allowlisted file that calls one of the helpers,
  `buildDispatchContext` must either be imported from another
  module or declared locally as a top-level function / const.
  Files that have neither fail CI. The contract is "symbol is in
  scope at runtime", so the guard accepts any of the three shapes
  that put it there:
    - **Named import** —
      `import { buildDispatchContext } from "./dispatch-context"`,
      optionally with a left-side `as` alias
      (`import { buildDispatchContext as buildCtx } ...`). The
      *imported* symbol must be `buildDispatchContext`; a right-side
      rename like `import { otherName as buildDispatchContext } ...`
      is rejected because it imports a different symbol and merely
      *names* the local binding `buildDispatchContext`, so the call
      site would dispatch to the wrong function. This is the form
      the Node track uses today.
    - **Namespace import + member access** —
      `import * as dispatchContext from "./dispatch-context"`
      paired with at least one
      `dispatchContext.buildDispatchContext(...)` reference in the
      same file. The bare namespace binding alone is not enough: the
      symbol is reachable through the namespace object, so the guard
      requires an observed member access to confirm the file is
      actually using it.
    - **Local declaration** — `async function buildDispatchContext` /
      `const buildDispatchContext = ...` declared at the top level
      (column 0) of the file. This is the shape Detection's
      `src/lib/detection/server-actions.ts` uses today.

  Three shapes intentionally do NOT satisfy the presence check:
    - **Type-only imports.** `import type { buildDispatchContext } ...`,
      `import { type buildDispatchContext } ...`, and
      `import type * as ns ...` are all rejected. TypeScript erases
      these so the symbol is not in runtime scope when the call site
      executes.
    - **Namespace imports without member access.** A bare
      `import * as ns from "..."` with no `ns.buildDispatchContext`
      reference fails — there is no evidence the file is materializing
      the symbol from the namespace.
    - **Nested declarations.** `function buildDispatchContext` /
      `const buildDispatchContext` inside another function or block
      does not bring the symbol into file scope. Only top-level
      (column-0) declarations count.

Both `pnpm check` (Biome) and `pnpm check:scope` must pass before
a PR can land. The guard is intentionally simple — it does not
verify that the dispatch context flows into the specific call
site, only that the symbol is in scope. Deeper correctness still
relies on code review.

The script strips line/block comments AND the contents of string
literals (single-quoted, double-quoted, and template-string) before
applying the call and presence regexes, so:

- A commented-out `import { buildDispatchContext } from "..."` does
  NOT satisfy the presence requirement.
- A commented-out call does NOT count as a real call.
- A string literal that happens to contain
  `import { buildDispatchContext } ...` (e.g. an error message,
  log line, or fixture) does NOT satisfy the presence requirement
  either, and a string literal containing `graphqlRequest(...)`
  does NOT trigger a violation.

Call detection runs against the whole stripped source so a call
split across lines (e.g. `return graphqlRequest\n  (QUERY, ...)`) is
still recognized. The scanner also walks past a balanced `<...>`
generic-arguments block before locating the opening `(`, so the
generic form (`graphqlRequest<Thing>(...)` and its multiline variant
`graphqlRequest<Thing>\n  (...)`) is recognized as the same call
site and the override-line range covers the helper-name line through
the opening-paren line. Newlines are preserved by the stripper so
reported line numbers stay aligned with the original source.
Template-literal interpolation expressions (`${...}`) are not parsed
back out — a real call buried inside `${...}` is missed and an
`import { buildDispatchContext }` substring inside `${...}` does not
satisfy the presence check either. Both edges are pathological in
real source, and the file-level allowlist still catches the only
meaningful regression: a brand-new server action outside
`src/lib/{node,detection}` that calls `graphqlRequest`.

To allow a deliberate exception, append an override comment to any
line of the call expression (helper-name line through the opening
paren — including the line containing `<` for generic calls):

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
  200 on both. An optional `inScopeBodyAssertion` callback runs
  against the parsed JSON body of every in-scope GET — use it for
  routes that return a list under a parent path (e.g.
  `GET /api/accounts/[id]/customers`) so the regression guard
  actually pins the returned data to the persona's customer rather
  than only asserting that the path is reachable.
- `mutation-scope` (POST / PATCH / DELETE) — each persona slot
  declares an optional `inScope` and `outOfScope` variant. The
  harness fires only the variants that are defined and asserts the
  response status equals the variant's `expectStatus` (typically 2xx
  in-scope, 403 / 404 out-of-scope for non-admins; 2xx for both for
  admin). An optional `cleanupAfterSuccess` hook resets fixture
  state after each 2xx so mutations don't leak between runs.
  - **Contract narrowing for auth-state-mutating routes.** The
    matrix's mandate is the cross-customer scope contract, not
    end-to-end coverage of every success path. Routes that mutate
    authentication state (password hash, locked flag, MFA
    enrolment, token version, live sessions) the matrix's other
    rows depend on declare ONLY the tenant `outOfScope` variant.
    Today this applies to `POST /api/accounts/[id]/password-reset`,
    `/unlock`, and `/mfa-reset`: a single 404 from
    `validateManagedAccountTarget` is the regression-meaningful
    assertion (a future PR that drops the scope check turns the row
    red), and the route-specific integration suites
    (`src/__integration__/api/unlock.test.ts`, the password / MFA
    suites) already cover the happy path end-to-end. New routes
    that share this profile should follow the same pattern; new
    routes that don't (no auth-state mutation) should declare every
    persona slot.
  - **Persona overrides.** A row whose route requires a permission
    the base tenant role doesn't carry (`customers:write`,
    `customers:delete`, `accounts:delete`) sets
    `personaUsernames: { accountA: MANAGER_A_USERNAME, accountB:
    MANAGER_B_USERNAME }`. The harness signs in those personas as
    the **manager** accounts (a non-`access-all` "tenant-
    administrator" role that holds the elevated permissions) so the
    request reaches the route's tenant-scope branch instead of being
    short-circuited at the permission gate. The persona label in
    the test name stays `account-A` / `account-B` so the matrix
    shape stays uniform; only the sign-in user changes. This is the
    pattern used by `PATCH /api/customers/[id]`,
    `DELETE /api/customers/[id]`, and `DELETE /api/accounts/[id]`.
  - **Targets that need a tenant-manageable role.** The
    `DELETE /api/accounts/[id]` row deletes the dedicated
    `monitor-target-A` / `-B` accounts (Security Monitor-equivalent
    role) rather than the tenant accounts, because
    `validateManagedAccountTarget` rejects targets whose role is
    not tenant-manageable with 403 before the scope check ever
    runs. Use the same pattern for any future route that calls
    `validateManagedAccountTarget` and needs the scope branch
    exercised.
  - **Structurally unreachable in-scope paths.** A few routes
    intentionally leave the tenant `inScope` variant undefined
    because the success path is blocked by a separate gate
    downstream of the scope check. `DELETE /api/customers/[id]` is
    the canonical case: the scope check requires the caller's
    `account_customer` link to exist, but the next gate
    (`Cannot delete customer with active account assignments`)
    refuses any customer with at least one link, so a
    non-`access-all` caller cannot pass both gates on the same
    customer. The `outOfScope` 404 is the regression-meaningful
    assertion for tenants; the admin in-scope variant covers the
    success path against an orphan customer.
Routes whose only tenant gate is a permission check with **no**
per-customer scope branch (e.g. `POST /api/customers`, which only
needs `customers:write`) are intentionally NOT in this matrix.
Any holder of the required permission — admin or a tenant-
administrator-style manager — can hit the success path, so there
is no cross-customer contract to assert. Permission-gate coverage
for those routes lives in the route's own integration suite, not
in this scope guard. Modeling them here would teach future authors
that the route is "admin-only" when in fact the matrix's manager
personas would also succeed.

**Adding a new customer-scoped endpoint is a one-line change** to
`ENDPOINTS`. Pick the appropriate `expects` mode, fill in the
`name`, `method`, and the mode-specific fields (`path` for
`list-scoped`, `pathFor` for detail GETs, `request` for mutations),
and the harness iterates and asserts automatically. If the new
endpoint needs a fixture row that is not in `Resources`, extend
`Resources` and the `beforeAll` seeder; otherwise the row alone
is enough.

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
- [ ] UI figures are included for new or changed features — a real
      screenshot when the feature needs no REview data, a placeholder
      when it shows real data received from REview
