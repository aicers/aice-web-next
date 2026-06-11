# Project guidelines

## Commit messages

- Title: preferably under 50 characters, start with imperative verb (e.g.,
  `Add`, `Fix`, `Remove`)
- Body: wrap at 72 characters, free-form, explain *why* not *what*
- Separate title and body with a blank line
- Reference issues: use `Closes #N` to close an issue, or `Part of #N` when
  the commit addresses part of an issue

## Attribution

- Do NOT add `Co-Authored-By` lines to commit messages.
- Do NOT add "Generated with Claude Code" or similar attribution to PRs or
  issues.

## Language

- Code, comments, commit messages, PR descriptions, and issues are written in
  English.

## Branching and pushing

- NEVER push directly to `main`. Always create a new branch before pushing.
- Branch names must follow the format `<github-username>/issue-#` (e.g., `alice/issue-42`).
  If there is no related issue, ask the user how to proceed before creating the
  branch.

## Package manager

- This project uses **pnpm** exclusively. NEVER use `npm`, `bun`, `yarn`, or
  any other package manager.
- Run CLI tools via `pnpm` (e.g., `pnpm vitest run`, `pnpm tsc --noEmit`,
  `pnpm biome check`). NEVER use `npx`.

## CI requirements

- Before committing, ensure all CI lint/check steps (e.g., Biome, type checks)
  would pass for the changed files.
- Before pushing or opening a PR, ensure the full CI pipeline passes locally
  (all checks, tests, and builds).

## Schema and migrations

Schema and migration rules live in `decisions/database-migration.md` and
`migrations/README.md`; read them before touching the schema. Two rules are
easy to get wrong:

- **Before the first tagged release**, do NOT add new migration files for a
  schema change. Edit the first schema version in place — the single
  `0001_*` file in each `migrations/<db>/` stream that builds the v1 schema.
  The pre-release history stays squashed into that clean v1 schema, so amend
  it rather than stacking incremental migrations on top.
- **Once a tagged release exists**, the released schema is frozen: never edit
  an already-released migration file (the checksum check aborts anyway). Add
  a new numbered migration for the change. Its baseline is the schema of the
  **immediately preceding released (tagged) version — NOT the previous commit
  / `HEAD~1`**. Production runs the last released schema, so the migration
  must upgrade cleanly from there. Unreleased migrations added since that tag
  belong to the in-progress release and may still be reworked, but the last
  *released* schema is never edited.
- For destructive changes, follow the forward-only, expand/contract rules in
  `decisions/database-migration.md`.

## Manual documentation

- A feature is not done until its manual page is written.
- Do not write docs for features still under active development.
- Keep the manual in sync with code — update docs whenever user-facing
  behavior changes.
- Feature descriptions should include UI screenshots, per these rules:
  - If the feature does not depend on data from REview, capture a real
    screenshot.
  - If the feature shows data received from REview, capture it from a
    stack with real data loaded rather than fabricated or
    hand-processed data.
  - If a real-data capture is not available, leave a placeholder
    instead of a fabricated screenshot (track the replacement capture
    in a separate issue).
- EN/KR pages must stay in sync (same structure, same filenames).
- See `docs/AUTHORING.md` for the full authoring guide.
