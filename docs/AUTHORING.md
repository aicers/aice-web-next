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
`scripts/capture-detection-screenshots.mjs` in the repository
root. It is Detection-specific today but is the canonical
example to copy when adding a sibling capture script for another
feature that needs this procedure.
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
