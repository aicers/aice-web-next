# Conflict-message fixtures (REview 0.47.0)

Each `*.txt` file is a verbatim capture of `errors[0].message` from a
real REview GraphQL response. Captures are checked in so that the
matcher in `src/lib/node/conflict-patterns.ts` is exercised against
the actual upstream wording, and so version-bump regressions surface
as fixture-mismatch failures rather than silent miscategorisations.

The capture procedure for each fixture is recorded in the file's
header comment (`# REview x.y.z — repro: ...`).

`decisions/node-conflict-patterns.md` documents the patterns,
mapped errors, and which form field each routes to. This directory
is the implementation-side counterpart Phase Node-4 owns; Phase
Node-9's stale-conflict replay tests reuse the same fixture files.
