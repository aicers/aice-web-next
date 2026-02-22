# Project guidelines

## Commit messages

- Title: max 50 characters, start with imperative verb (e.g., `Add`, `Fix`,
  `Remove`)
- Body: wrap at 72 characters, free-form, explain *why* not *what*
- Separate title and body with a blank line
- Reference issues with `Closes #N` or `Refs #N` in the body

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

## CI requirements

- Before committing, ensure all CI lint/check steps (e.g., Biome, type checks)
  would pass for the changed files.
- Before pushing or opening a PR, ensure the full CI pipeline passes locally
  (all checks, tests, and builds).
