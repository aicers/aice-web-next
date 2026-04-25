# Node & service management — upstream conflict-message patterns

The REview GraphQL schema does not expose typed error payloads for node / service mutations. Every error comes back as `GraphQLError.message: string`. To route server-reported conflicts to specific form fields or retry paths, aice-web-next matches the message against the patterns below.

**These patterns are version-sensitive.** Every time the pinned REview version moves, the patterns need re-verification against live server output. Fixtures captured from the REview repo and from manual reproduction drive the unit tests that guard these patterns.

## Ownership split

- **This document** (initial regex + mapped error + upstream source reference) lands pre-implementation as part of the `decisions/` chore (`#318`).
- **Fixture capture** — running the REview binary, reproducing each conflict, recording the `errors[0].message` string, and committing a fixture file per pattern — is owned by **Phase Node-4 (#310)**, because Node-4 is the first sub-issue that actually handles server-reported conflicts in the UI. Node-4's PR creates the fixture directory `src/__tests__/lib/node/fixtures/conflict-messages/` and populates it with one fixture per row of the table below, then wires the matching `src/lib/node/conflict-patterns.ts` implementation.
- **Phase Node-9 (#314)** consumes both this document and the fixtures that Node-4 captures for the stale-conflict replay path.
- When a REview version bump changes a message, the corresponding test fails first (the fixture still reflects the old wording); update the fixture, regex, and the upstream source reference together in a follow-up PR.

## Pattern table (v1, REview 0.47.0)

These are the shapes the BFF recognises. If a message does not match any pattern, it falls through to a generic `UpstreamError` surfaced as a form-level banner.

The regexes below are shown as JavaScript regex literals. Where alternation is meant, the **rendered** form is the JS-standard `|` — the `\|` you may see in this file's raw markdown source is the markdown-table pipe-escape applied automatically by the renderer; the live `conflict-patterns.ts` file uses `|` directly with no backslash.

| Regex | Mapped error | UI behaviour | Upstream source (to verify on version bump) |
|---|---|---|---|
| `/^the node's name already exists\b/i` | `NodeNameUniqueError` | Inline under the Name field | `review-web/src/graphql/node/crud.rs` — node name uniqueness check |
| `/hostname .* already in use\b/i` | `NodeHostnameUniqueError` | Inline under the Hostname field | `review-web/src/graphql/node/crud.rs` — hostname uniqueness check |
| `/customer .* not found\b/i` or `/no access to customer\b/i` | `NodeCustomerScopeError` | Inline under the Customer field | `review-web/src/graphql/node/crud.rs` — customer-scope guard |
| `/(concurrent modification\|node was modified\|stale)\b/i` | `StaleConflictError` | Triggers the one-shot replay in Phase Node-9; if the replay also fails, prompts the user to discard or re-edit | `review-web/src/graphql/node/crud.rs` — updateNodeDraft CAS check |
| `/agent .* not found\b/i` | `AgentNotFoundError` | Inline on the affected service card | `review-web/src/graphql/node/agent.rs` |

The live regex list in `conflict-patterns.ts` is authoritative for the code; this table exists to document the intent and the correspondence with REview source.

## Fixture captures (owned by Phase Node-4)

Each regex is accompanied by a captured-fixture file under `src/__tests__/lib/node/fixtures/conflict-messages/`. These fixtures are **not** present when this document first lands via the `#318` chore; Phase Node-4 (#310) adds them as part of its implementation. The fixture file is a plain-text capture of a real error message, obtained by:

1. Running the REview binary at the pinned version in a local test deployment.
2. Triggering the conflict (e.g., two concurrent `updateNodeDraft` calls with the same `old`).
3. Recording the `errors[0].message` string from the response.

The fixture file's header comment records the REview version and the reproduction steps.

## What to do when REview adds typed error payloads

If a future REview release switches to typed error extensions (`errors[0].extensions.code` or a custom `union` return), migrate the pattern-matching layer to read the typed field instead. The public surface of `conflict-patterns.ts` (mapped errors + UI behaviour) stays the same; the matching rules just become more robust.
