# RFC 0002: aimer-web Phase 2 ingestion contract (per-customer)

- Status: **Draft — pending aimer-web team review**
- Authors: @sehkone
- Tracks: [#491](https://github.com/aicers/aice-web-next/issues/491)
- Related: [#437](https://github.com/aicers/aice-web-next/issues/437), [#438](https://github.com/aicers/aice-web-next/issues/438), [#441](https://github.com/aicers/aice-web-next/issues/441), [#461](https://github.com/aicers/aice-web-next/issues/461), [#462](https://github.com/aicers/aice-web-next/issues/462), [#471](https://github.com/aicers/aice-web-next/issues/471), [#473](https://github.com/aicers/aice-web-next/issues/473), [#489](https://github.com/aicers/aice-web-next/issues/489), [#492](https://github.com/aicers/aice-web-next/issues/492), [#493](https://github.com/aicers/aice-web-next/issues/493), [#494](https://github.com/aicers/aice-web-next/issues/494), [#495](https://github.com/aicers/aice-web-next/issues/495), [#565](https://github.com/aicers/aice-web-next/issues/565)
- Paired aimer-web umbrella: TBD (filed alongside this RFC)

## Summary

Phase 2 sends Triage Baseline events, Stories, and Policy runs from aice-web-next to aimer-web so the latter can produce LLM-driven analyses and reports. Communication is one-way (aice-web-next → aimer-web, browser-mediated to respect aice-web-next's air-gapped deployment), incremental for streaming data (Baseline, Story), and on-demand for batched user-curated work (Policy run). aimer-web stores ingested data in a new query-friendly schema separate from the Phase 1 `detection_events` blob sink, which continues to serve the orthogonal use case of ad-hoc single-event sends from the Detection menu. Cross-customer Story analysis is explicitly deferred to a Phase 3 RFC; the identifier policy in this RFC keeps that path forward-compatible.

## Motivation

aimer-web's role is LLM-based analysis and reporting on top of aice-web-next's detection corpus. To do this it needs:

1. **Continuous data** — ongoing Baseline events and Stories as they are produced
2. **Bounded data** — Policy runs as immutable user-curated batches
3. **Rich per-event context** — selector tags, window-level signals, asset context — that the LLM can reason from

aice-web-next's deployment constraints add three further requirements:

4. **Air-gap respect** — aice-web-next servers cannot initiate outbound network traffic; aimer-web cannot poll aice-web-next. All cross-boundary movement happens through user browsers.
5. **One-way contract** — aimer-web cannot ask aice-web-next for anything. Whatever data aimer-web needs must arrive via push.
6. **Customer isolation** — both systems use per-customer databases. Phase 2 stays within that boundary; cross-customer correlation is Phase 3.

Phase 1 already handles the orthogonal use case of "send this single Detection event for one-shot analysis" via the bridge handoff to `detection_events` ([#441](https://github.com/aicers/aice-web-next/issues/441)). Phase 2 does **not** subsume Phase 1; it adds incremental sync for the structured Triage and Story data on top.

## Scope

### In scope

- Wire format for pushing Baseline events, Stories, Policy runs, withdraw notices, and refresh notices from aice-web-next to aimer-web
- Identifier policy that uniquely names rows across the boundary
- aimer-web side storage shape sufficient to support analysis lookup and report queries
- Push trigger UX, consent model, failure handling on aice-web-next side
- Cursor / sync-state design on aice-web-next side (treated as internal implementation, not contract)
- Coexistence rules between Phase 1 (`detection_events`) and Phase 2 storage

### Out of scope (deferred or owned elsewhere)

- **Cross-customer Story analysis** — deferred to Phase 3 RFC (see §10)
- **LLM prompt design, model selection, narrative storage, prompt/model versioning** — owned by aimer-web team
- **Specific report menus and analytics surfaces in aimer-web** — owned by aimer-web team; this RFC defines the data substrate they query
- **Privacy-related field redaction** — separate topic; this RFC permits a future redaction hook in the push pipeline but does not specify it
- **Encryption-at-rest details for new Phase 2 tables** — aimer-web team's choice within the constraints of this RFC's identifier policy
- **Detection-menu adjacent multi-window context packaging** — already tracked as [#495](https://github.com/aicers/aice-web-next/issues/495)
- **Approval workflow before Send** — already tracked as [#494](https://github.com/aicers/aice-web-next/issues/494)
- **System Administrator cross-customer surfaces** — Phase 3

## Identifier policy

Every cross-system identifier in Phase 2 follows two rules:

1. **Customer scope is always explicit.** The token used in payloads and storage is the immutable string `external_key` from `customers.external_key` ([#438](https://github.com/aicers/aice-web-next/issues/438)), not aice-web-next's `INTEGER customer_id` nor aimer-web's `UUID customer_id`. The two systems hold different internal types for the same logical customer; `external_key` is the only stable identifier across the boundary.
2. **Row keys are tuples that always include `external_key`.** No identifier is ever sent or stored bare. Specifically:

| Logical row | Wire key (in payloads) | aimer-web storage PK (per-customer DB) |
|---|---|---|
| Baseline event | `(external_key, baseline_version, event_key)` | `(baseline_version, event_key)` |
| Story | `(external_key, story_id, story_version)` | `(story_id, story_version)` |
| Story member | `(external_key, story_id, story_version, member_event_key)` | `(story_id, story_version, member_event_key)` |
| Policy run | `(external_key, run_id)` | `(run_id)` |
| Policy event | `(external_key, run_id, event_key)` | `(run_id, event_key)` |

In aimer-web's per-customer DBs, `customer_id` is the **implicit partition key** — the database itself is the customer scope, so storage PKs omit it. Per-customer routing on the receiver side uses the **payload's `external_key`** after verifying it is a member of the context token's signed `customer_ids[]` claim (§6.1). The signed claim authorizes the session for a set of customers; the payload picks which one of those authorized customers this specific push targets. Routing and stored meta both use the payload's verified `external_key`.

`event_key` is the `NUMERIC(39, 0)` natural key from REview, sent as a string in payloads (JSON cannot represent i128 safely).

This tuple-shape is the single most load-bearing decision in this RFC. It keeps Phase 2 storage cleanly partitioned by customer, makes withdraw/refresh notices unambiguous, and is forward-compatible with Phase 3 cross-customer Story (where a Story's member set spans multiple `external_key`s but each member is still individually addressable as `(external_key, event_key)`).

### Note on existing contract drift

The current [#492](https://github.com/aicers/aice-web-next/issues/492) issue body uses `tenant_id` as the payload field name. This RFC supersedes that naming; the field is `external_key`. A follow-up edit to [#492](https://github.com/aicers/aice-web-next/issues/492) tracks the rename.

## Storage model on aimer-web

### Existing: `detection_events` (Phase 1)

Kept as-is. Continues to serve ad-hoc single-event sends from the Detection menu when the event is **not** baseline-passing. KEK rotation, encryption-at-rest, staged-event approval workflow all remain operational.

### New: Phase 2 tables

The following tables live in aimer-web's per-customer DBs (`migrations/customer/`). Exact column types, indexes, encryption strategy, and runtime role grants are aimer-web team's choice; this RFC fixes only the identifying columns and the relationship shape.

All Phase 2 tables live in aimer-web's per-customer DBs, so `customer_id` is implicit (the database is the customer scope) and is omitted from PKs.

```
baseline_event
  PK (baseline_version, event_key)
  + indexed: event_time, kind, category, primary_asset, raw_score
  + payload: full event row from REview (packet bytes excluded), selector_tags,
             raw_score (within-kind weighted sum, persisted at INSERT per RFC 0001),
             score_window_context (snapshot of the cohort window + size +
                                   baseline_rank_snapshot — see §6),
             window-level signal snapshot (S1 percentile rank, S3 recurring count,
             S4 correlated count + correlated event_keys),
             asset short context, scoring weights snapshot
  + meta: received_at, source_aice_id

  NOTE: baseline_score (kind-normalized percentile) is NOT stored as a separate
  column. Per RFC 0001 it is a read-time value; the exact value at push time
  is preserved as baseline_rank_snapshot inside score_window_context. Reports
  display that value as "the ranking the analyst saw."

story
  PK (story_id, story_version)
  + indexed: time_window_start, time_window_end, primary_asset, score
  + payload: kind ('auto_correlated' | 'analyst_curated'), correlation_rule_id,
             score, summary_payload (mirrors aice-web-next's Story card JSONB)
  + meta: received_at, source_aice_id

story_member
  PK (story_id, story_version, member_event_key)
  FK (story_id, story_version) → story
  + member_event_key (NUMERIC string), role ('primary' | 'context')
  + payload: full event row inline (self-contained payload rule)

policy_run
  PK (run_id)
  + indexed: created_at, finalized_at, baseline_version
  + payload: policies_fingerprint, exclusions_fingerprint, baseline_version,
             status snapshot at send time, summary stats
  + meta: received_at, source_aice_id

policy_event
  PK (run_id, event_key)
  + indexed: event_time, kind, category
  + payload: identity columns mirroring policy_triaged_event
             (event_time, kind, sensor, orig_addr, orig_port, resp_addr,
              resp_port, proto, host, dns_query, uri, category) +
             policy_triage_snapshot (JSONB list of { policyId, score })
  + NOT included: raw_score, selector_tags, window_signals,
                  score_window_context — corpus B is policy-mode only and
                  does not carry the baseline-centric snapshot
                  (see migration 0009 comment).
                  aimer-web can join against its own baseline_event by
                  event_key when corpus-A enrichment is desired.

analysis_narrative
  PK (content_hash)
  + content_hash := hash(target_kind, target_keys, summary_payload, signals,
                         prompt_version, model_version)
  + payload: LLM output narrative, prompt_version, model_version, analyzed_at
  + indexed: target_kind ('baseline_event' | 'story' | 'policy_run'), generated_at
  + foreign references: target rows by tuple key (not strict FK, since narrative
                        outlives target retention)
```

### Why not extend `detection_events`?

`detection_events` is a query-opaque encrypted blob with KEK rotation and staged-approval workflow built around the assumption "store this opaque thing securely for later one-shot retrieval." Phase 2 needs query-friendly indexed columns, frequent reads, joins, and incremental sync semantics. Bolting both onto one table forces unhappy compromises on both axes. Keeping the two separate lets each optimize for its own access pattern and keeps Phase 1's security model intact.

## Wire contract

All endpoints live under `https://<aimer-web-host>/api/phase2/`. Request `Content-Type: multipart/form-data` with the three fields described in §6.1 (`context_token`, `events_envelope`, `events_data`). The `events_data` part itself contains JSON bytes; the HTTP body is not JSON.

### Authentication: signed envelopes (no shared secret in browser)

Phase 2 reuses **the exact wire format already implemented for the Phase 1 bridge handoff** — same multipart structure, same two-JWS pattern, same `trust_registry` verification on aimer-web side, same signing keypair from the [#437](https://github.com/aicers/aice-web-next/issues/437) settings UI. No new crypto, no new claim set. A shared bearer token in the browser would be exfiltrable, so it is not used.

**Concrete format** (as implemented today; sender [`src/lib/aimer/context-token.ts`](src/lib/aimer/context-token.ts), [`src/lib/aimer/events-envelope.ts`](src/lib/aimer/events-envelope.ts); receiver under `aimer-web/src/lib/auth/`):

The HTTP request to every Phase 2 endpoint is `multipart/form-data` with three fields:

| Field | Type | Content |
|---|---|---|
| `context_token` | string (JWS compact) | session/authorization token |
| `events_envelope` | string (JWS compact) | data-integrity envelope |
| `events_data` | File or string | the Phase 2 JSON payload bytes (schemas in §6 below); SHOULD use `Content-Type: application/json; charset=utf-8` on the multipart part |

**Context token** (ES256 JWS):

| Claim | Type | Notes |
|---|---|---|
| `alg` (header) | `"ES256"` | |
| `kid` (header) | string | identifies trust_registry key |
| `iss` | string | issuer (matches `aice_id` for self-issued tokens) |
| `aud` | `"aimer-web"` | constant audience |
| `sub` | string | account ID issuing this push |
| `aice_id` | string | identifies the aice-web-next instance |
| `customer_ids` | string[] | array of `external_key`s this session is authorized to push for (max 20) |
| `iat` / `exp` | seconds | canonical TTL = 60s |
| `jti` | UUID | unique per token, used for replay rejection |

**Events envelope** (ES256 JWS):

| Claim | Type | Notes |
|---|---|---|
| `alg`, `kid` (header) | | same |
| `iss`, `aice_id`, `customer_ids` | | must match context token (cross-checked at verification) |
| `schema_version` | string | identifies the inner-payload schema, e.g. `"phase2.baseline.v1"`, `"phase2.story.v1"`, `"phase2.policy_run.v1"`, `"phase2.withdraw.v1"`, `"phase2.refresh_window.v1"`, `"phase2.backfill.v1"` |
| `event_count` | integer | number of logical items in the payload |
| `iat` / `exp` | seconds | freshness window |
| `context_jti` | UUID | echoes the context token's `jti` — links the two |
| `payload_hash` | base64url | `SHA-256(events_data)` |

The Phase 2 JSON payload (§6 schemas below) is serialized to bytes and sent as `events_data`. The envelope JWS carries only the **hash**, not the data — so large batches do not need to be embedded in JWS.

Per-push flow:

1. The browser, on an authenticated aice-web-next session, calls a local aice-web-next route requesting tokens for a specific Phase 2 push (kind + selectors). The route constructs the JSON payload, signs both JWSes, and returns `{ context_token, events_envelope, events_data }` to the browser.
2. The browser POSTs the multipart to the aimer-web Phase 2 endpoint (`https://<aimer-web-host>/api/phase2/...`).
3. aimer-web's `verifyContextToken` validates the context token (signature via `trust_registry`, freshness, `customer_ids` size cap). aimer-web's `verifyEventsEnvelope` validates the events envelope (signature, payload size cap via `BRIDGE_MAX_PAYLOAD_BYTES` env, `payload_hash` matches `SHA-256(events_data)`, `context_jti` matches context token's `jti`, `iss`/`aice_id`/`customer_ids` match context token).
4. Verified `events_data` bytes are parsed as JSON per `schema_version` and ingested.

The browser never sees the private key and never holds a long-lived secret. Tokens are short-lived (60s) and replay-rejected on `jti`. The aice-web-next server makes no outbound network call — only the browser does.

**Per-push customer scope.** A single Phase 2 push targets exactly one customer (the per-customer DB on aimer-web is the storage scope). The context token's `customer_ids` array authorizes one or more customers for the session, but the per-push payload's `external_key` (§6 schemas) selects which authorized customer this specific push is for. aimer-web **must reject** when the payload's `external_key` is not a member of the context token's `customer_ids` (`403 Forbidden`, `code = "payload_customer_not_authorized"`). Routing to the per-customer DB uses the payload's `external_key`; storage meta also records the payload's `external_key`.

**`aice_id` consistency.** The events envelope carries `aice_id` as a signed claim; the payload may carry `source_aice_id` for self-documentation. If both are present and disagree, aimer-web rejects with `403 Forbidden`, `code = "envelope_payload_aice_id_mismatch"`. The verified envelope claim is what gets stored in meta; the payload value is informational only.

**Retry vs replay.** Tokens are single-use on `jti`, but storage endpoints are idempotent on natural keys (`baseline_version + event_key`, `story_id + story_version`, `run_id + event_key`). The reconciliation:

- **Each retry mints fresh tokens** with a new `jti`. The browser's retry loop returns to aice-web-next first to obtain a new token pair, then POSTs to aimer-web.
- **Duplicate prevention lives at the storage layer**, not at the token layer. A successful prior delivery whose response was lost simply becomes `duplicates_skipped = N` on the next attempt (since natural keys match).
- **`jti` replay is hard-rejected** by aimer-web with `409 Conflict`, `code = "context_jti_replay"`. aice-web-next treats this as a programming error and surfaces it as a visible failure, not as a normal retry path.

The combination keeps tokens simple (truly single-use), keeps idempotency where natural keys live (storage), and avoids any response-replay cache on aimer-web side.

Configuration on aice-web-next:

- **Aimer base URL**: reuses the existing `aimer_web_bridge_url` system setting from [#437](https://github.com/aicers/aice-web-next/issues/437) (UI-only, no environment-variable bootstrap). Phase 2 endpoints `/api/phase2/*` live under the same aimer-web host as the Phase 1 bridge endpoint, so the host portion is shared. If aimer-web ever needs to host Phase 2 on a separate base path, the resolution is to add a sibling system setting in the same [#437](https://github.com/aicers/aice-web-next/issues/437) UI (e.g., `aimer_web_phase2_base_url`), not an env var.
- **Signing keypair**: lives in [#437](https://github.com/aicers/aice-web-next/issues/437) settings storage. No `AIMER_WEB_INTAKE_TOKEN` is used.
- **Request timeout**: hardcoded default 30s; if a tunable becomes necessary, it follows the same UI-only pattern.

The precise envelope format (JWS header fields, signature algorithm, `jti` replay store, claim names) is whatever the current Phase 1 verification code accepts — Phase 2 does not redefine it. If Phase 1 hardening ([aimer-web#197](https://github.com/aicers/aimer-web/issues/197)) ever changes the format, Phase 2 changes with it automatically because both sides use the same verification module.

**Phase 2 ingestion path is separate from Phase 1 staged workflow.** Phase 1's bridge route (`/api/auth/bridge`) writes to `staged_event_payloads` and waits for explicit per-customer approval before promoting to `detection_events`. Phase 2 endpoints (`/api/phase2/*`) verify the envelope using the same shared module but then **INSERT directly into the Phase 2 tables** (§5) with no staging, no approval gate. This is intentional: Phase 2 is incremental sync of structured data the user already consented to via the [#437](https://github.com/aicers/aice-web-next/issues/437) one-time consent (§8 Trigger UX & consent model), whereas Phase 1 is ad-hoc per-event sends that warrant per-item approval.

Aimer-web implementation note: the envelope verification logic that today lives inside the Phase 1 bridge route handler must be extracted into a shared helper (e.g., `verifyAimerEnvelope(req): { envelope, payload }`) so Phase 2 route handlers can reuse it without duplicating signature/nonce/freshness checks.

### Endpoints

**The HTTP body of every endpoint below is `multipart/form-data` per §6.1.** The JSON schemas in this section describe the bytes inside the `events_data` part **after** `context_token` verification and `events_envelope` verification succeed (signature, `payload_hash` match, `context_jti` link, customer authorization). Multipart with missing or invalid tokens is rejected before any schema check (`400` for shape errors, `401`/`403` for token failures). Schema validation runs on the verified `events_data` bytes; payload-shape failures return `400` after token verification has already accepted the request.

The `schema_version` claim in `events_envelope` (§6.1) selects which schema below applies:

| `schema_version` | Endpoint | Payload schema |
|---|---|---|
| `phase2.baseline.v1` | `POST /api/phase2/baseline/batch` | Baseline batch |
| `phase2.story.v1` | `POST /api/phase2/story/batch` | Story batch |
| `phase2.policy_run.v1` | `POST /api/phase2/policy-run` | Policy run |
| `phase2.withdraw.v1` | `POST /api/phase2/withdraw` | Withdraw |
| `phase2.refresh_window.v1` | `POST /api/phase2/refresh-window` | Refresh window |
| `phase2.backfill.v1` | `POST /api/phase2/backfill` | Backfill (same as refresh-window) |

**`event_count` definition** (§6.1 `events_envelope` claim): the number of logical items in the inner payload. Concretely:

| `schema_version` | `event_count` counts |
|---|---|
| `phase2.baseline.v1` | `events.length` |
| `phase2.story.v1` | `stories.length` |
| `phase2.policy_run.v1` | `events.length` (the child events of the single run) |
| `phase2.withdraw.v1` | total across all `withdrawals[*]` items (e.g., sum of `event_keys.length` for keyed kinds, plus 1 per single-item entry) |
| `phase2.refresh_window.v1` | `events.length` (or `stories.length` for story-kind windows; 0 if clearing) |
| `phase2.backfill.v1` | same as `refresh_window` |

All endpoints are idempotent on their natural keys: re-delivery of the same logical content is a no-op (returns `duplicates_skipped`); re-delivery of the same content with new `received_at` does not produce duplicate rows. Time ranges are **half-open `[from, to)`** unless stated.

#### `POST /api/phase2/baseline/batch`

Push a batch of Baseline events. Used by opportunistic push and by manual "sync now" from settings.

```jsonc
{
  "external_key": "customer-external-key-string",
  "source_aice_id": "aice-instance-id-string",
  "baseline_version": "1.B.0",
  "events": [
    {
      "event_key": "12345678901234567890",
      "event_time": "2026-05-10T00:00:00Z",
      "kind": "HttpThreat",
      "category": "COMMAND_AND_CONTROL",
      "raw_score": 1.42,
      "selector_tags": ["S1_cluster_none", "UNLABELED_BONUS"],
      "raw_event": { /* full REview row, packet bytes excluded */ },
      "score_window_context": {
        "kind_cohort_window": { "from": "2026-05-03T00:00:00Z", "to": "2026-05-10T00:00:00Z" },  // window the snapshot was taken against
        "kind_cohort_size": 1842,                                                                  // informational
        "baseline_rank_snapshot": 0.92                                                             // exact baseline_score in the snapshot window (RFC 0001 §3)
      },
      "window_signals": {
        "s1_percentile_rank": 0.99,
        "s3_recurring_count": 12,
        "s4_correlated_count": 4,
        "s4_correlated_event_keys": ["...", "..."]
      },
      "asset_context": {
        "primary_asset": "192.168.1.20",
        "peer_event_summary": { /* condensed summary of other events from same asset in window */ }
      },
      "scoring_weights_snapshot": { /* RFC 0001 §9 weights at push time */ }
    }
    // ...
  ]
}
```

`baseline_score` is intentionally absent at the row level — see §5 NOTE and RFC 0001 §3 (kind-normalized percentile is read-time, not a stable row attribute). The snapshot `baseline_rank_snapshot` inside `score_window_context` is the event's exact `baseline_score` against the specific cohort window noted there. aimer-web uses this value as the canonical "ranking the analyst saw at push time."

**Cross-window ranking is not supported in this contract version.** If aimer-web reports later need to display an event's ranking in a window other than the snapshot's, that is an additive RFC change — either extend `score_window_context` with the full cohort distribution, or have aimer-web compute `CUME_DIST() OVER (kind, baseline_version)` against its own accumulated `baseline_event` corpus. Neither is in this RFC's scope; both are forward-compatible additions.

Note that `window_signals.s1_percentile_rank` is a different quantity — the S1 selector's confidence-percentile signal — and is **not** the triage ranking.

Response:

```jsonc
{
  "accepted": 42,
  "duplicates_skipped": 3,
  "received_at": "2026-05-10T00:01:00Z",
  "context_jti": "..."
}
```

`context_jti` echoes the context token's `jti` so aice-web-next can ack-match the response to the originating push; the cursor advances only on a successful response (see §7 Push queue).

#### `POST /api/phase2/story/batch`

Push a batch of Stories. Used by opportunistic push and by per-Story manual Send ([#493](https://github.com/aicers/aice-web-next/issues/493)) — manual Send sends a batch of size 1.

```jsonc
{
  "external_key": "customer-external-key-string",
  "source_aice_id": "aice-instance-id-string",
  "stories": [
    {
      "story_id": "12345",                   // stringified BIGINT (event_group.id, BIGSERIAL)
      "story_version": "v1",
      "kind": "auto_correlated",
      "correlation_rule_id": "R1",
      "primary_asset": "192.168.1.20",
      "time_window": { "start": "2026-05-10T00:00:00Z", "end": "2026-05-10T00:12:00Z" },
      "score": 4.2,
      "summary_payload": { /* JSONB rendered on Story cards in aice-web-next */ },
      "members": [
        {
          "event_key": "12345678901234567890",
          "role": "primary",
          "event": { /* full event row inline, matching baseline_event payload shape */ }
        }
        // ...
      ]
    }
    // ...
  ]
}
```

Response: same shape as baseline batch.

`force_refresh` (per-Story bool, optional) inside an item bypasses aimer-web's `analysis_narrative` cache and triggers a fresh LLM pass — used by the Send button when the user explicitly wants re-analysis (e.g., after a Story Force Rebuild [#565](https://github.com/aicers/aice-web-next/issues/565) for the same natural key).

#### `POST /api/phase2/policy-run`

One run per call (manual, on-demand only).

`run_id` on the wire is the **stringified BIGINT** value of `policy_triage_run.id` (`BIGSERIAL` per [migration 0009](migrations/customer/0009_policy_corpus_b.sql:29)) — sent as a string for the same reason as `event_key`: JSON cannot safely represent values that may exceed 2^53.

Policy events have a different shape from baseline events. Per [migration 0009](migrations/customer/0009_policy_corpus_b.sql:115), `policy_triaged_event` carries **identity columns + `policy_triage_snapshot` (JSONB list of `{ policyId, score }`)** and intentionally does NOT carry corpus-A-style `raw_score` / `selector_tags` / window signals (corpus B is policy-mode only, not baseline-centric). The wire payload mirrors this shape natively. If aimer-web wants baseline-style enrichment for the same event_key, it joins against its own Phase 2 `baseline_event` table when a row exists.

```jsonc
{
  "external_key": "customer-external-key-string",
  "source_aice_id": "aice-instance-id-string",
  "run": {
    "run_id": "1234",                        // stringified BIGINT (policy_triage_run.id)
    "owner_account_id": "uuid-of-account",   // policy_triage_run.owner_account_id (UUID, references auth_db.accounts)
    "period_start": "2026-05-01T00:00:00Z",
    "period_end":   "2026-05-08T00:00:00Z",
    "created_at":   "2026-05-10T00:00:00Z",
    "finalized_at": "2026-05-10T00:01:33Z",
    "baseline_version": "1.B.0",
    "policies_fingerprint":  "hex-or-base64",
    "exclusions_fingerprint": "hex-or-base64",
    "status": "ready",                       // 'ready' | 'superseded' (only these two are sent; 'computing' / 'failed' are never pushed)
    "replaces":      "1233",                 // optional, stringified BIGINT of prior run if this superseded one
    "summary_stats": { "total_events": 421, "kinds_represented": 7 }
  },
  "events": [
    {
      "event_key":  "12345678901234567890",  // stringified NUMERIC(39, 0) from policy_triaged_event
      "event_time": "2026-05-10T00:00:00Z",
      "kind":       "HttpThreat",
      "sensor":     "sensor-id",
      "orig_addr":  "192.168.1.20",
      "orig_port":  54321,
      "resp_addr":  "10.0.0.5",
      "resp_port":  443,
      "proto":      6,
      "host":       "...",                   // exclusion-matching column (nullable)
      "dns_query":  null,
      "uri":        null,
      "category":   "COMMAND_AND_CONTROL",
      "policy_triage_snapshot": [            // JSONB from policy_triaged_event.policy_triage_snapshot
        { "policyId": "P1", "score": 0.82 },
        { "policyId": "P3", "score": 0.45 }
      ]
    }
    // ...
  ]
}
```

Response: same shape as baseline batch.

Note on supersede chain: when aice-web-next pushes a new run that supersedes an earlier one (`replaces` populated), aimer-web does **not** automatically delete the prior run's data — both runs remain queryable. Aice-web-next emits a separate withdraw notice (§6 withdraw) only if the prior run should be removed from aimer-web's view, which is not the default behavior.

#### `POST /api/phase2/withdraw`

Tell aimer-web that specific rows are no longer current truth. Used when aice-web-next-side exclusions retroactively delete corpus rows ([retroactive-delete.ts](src/lib/triage/exclusion/retroactive-delete.ts)) or when a Story is dropped post-rebuild.

```jsonc
{
  "external_key": "customer-external-key-string",
  "withdrawals": [
    { "kind": "baseline_event", "baseline_version": "1.B.0", "event_keys": ["...", "..."] },
    { "kind": "story", "story_id": "12345", "story_version": "v1" },           // story_id stringified BIGINT
    { "kind": "policy_event", "run_id": "1234", "event_keys": ["..."] },        // run_id stringified BIGINT
    { "kind": "policy_run", "run_id": "1234" }                                  // optional: removes run + cascades to its events
  ]
}
```

`baseline_version` is required for `baseline_event` withdrawals (a key alone is ambiguous across versions). `story_version` is required for `story` withdrawals. `policy_run` withdrawal is permitted but **not** the default reaction to supersede — supersede produces a new `run_id` alongside the old; only an explicit cleanup decision (e.g., operator action or aimer-web-side retention via aice-web-next signal) results in a `policy_run` withdraw notice. When a `policy_run` is withdrawn, aimer-web cascades the delete to its `policy_event` rows.

aimer-web deletes matching rows from the Phase 2 tables. Cached `analysis_narrative` rows whose target was withdrawn are not automatically deleted; they age out via aimer-web retention.

Response:

```jsonc
{ "withdrawn": 17, "not_found": 2, "received_at": "...", "context_jti": "..." }
```

`not_found` is informational and not an error (race vs prior withdrawal is benign).

#### `POST /api/phase2/refresh-window`

Tell aimer-web that a half-open time window has been re-computed authoritatively on aice-web-next's side (Force Rebuild for Baseline [#473](https://github.com/aicers/aice-web-next/issues/473) or Story [#565](https://github.com/aicers/aice-web-next/issues/565)).

```jsonc
{
  "external_key": "customer-external-key-string",
  "window": {
    "kind": "baseline_event",
    "from": "2026-05-01T00:00:00Z",  // inclusive
    "to":   "2026-05-08T00:00:00Z"   // exclusive
  },
  "baseline_version": "1.B.0",
  "events": [ /* full new content for the window — same shape as baseline batch */ ]
}
```

`baseline_version` is required when `window.kind = "baseline_event"`.

For `window.kind = "story"`, the body carries `stories` (not `events`) with `story_id` + `story_version` per item, where `story_id` is the stringified BIGINT from `event_group.id` ([migration 0008:23](migrations/customer/0008_event_group_story.sql:23)). Replace semantics for stories:

- **Scope**: replaces all auto-correlated stories (`kind = 'auto_correlated'`) whose `time_window_start ∈ [from, to)`. **Curated stories (`kind = 'analyst_curated'`) are never affected**, mirroring the [#565](https://github.com/aicers/aice-web-next/issues/565) Force Rebuild behavior on aice-web-next side.
- **`story_id` is not preserved across rebuild**: aice-web-next's [#565](https://github.com/aicers/aice-web-next/issues/565) does DELETE-then-INSERT, so post-rebuild stories carry **new** `story_id` values from the `BIGSERIAL` sequence. The natural-key carry-over of `last_sent_at` (per [#565](https://github.com/aicers/aice-web-next/issues/565)) is internal to aice-web-next and does not change `story_id`. aimer-web's storage of the replaced window therefore loses the old `story_id` rows and gains entirely new ones; this is correct.
- **Cross-version**: if `STORY_VERSION` happens to be bumped between the old and new content of the same window, both the old `story_version` rows and the new `story_version` rows in that window are replaced (i.e., the time-range filter is the only filter; version is not).

Atomicity: aimer-web replaces the window's contents in a single transaction (delete-then-insert under an advisory lock keyed on `(external_key, kind, window)`). If the body is empty events/stories, the window is cleared.

Response: same shape as baseline batch, with refresh-specific field meanings:

- `accepted` — number of replacement rows inserted (== `events.length` or `stories.length` for the requested window)
- `duplicates_skipped` — always 0 for refresh (the window was cleared before insert; no natural-key collision possible)
- `received_at`, `context_jti` — same as elsewhere

Optionally aimer-web MAY include `deleted` (count of rows removed during the replacement) for operator observability; it is not required.

#### `POST /api/phase2/backfill`

**Structurally identical to `refresh-window`** — same payload, same DELETE-then-INSERT semantics under the same advisory lock, same response shape (`accepted` = inserted rows, `duplicates_skipped = 0` always, optional `deleted` count). The discriminator between the two is the `schema_version` claim (`phase2.backfill.v1` vs `phase2.refresh_window.v1`) and the audit action emitted (`aimer_phase2.backfill` vs `aimer_phase2.refresh_window`).

**Why a separate endpoint then?** Two reasons, both operational not behavioral:

1. **Intent / audit clarity** — backfill is an explicit operator action ("seed this historical window") whereas refresh-window is reactive (Force Rebuild fired). Distinct audit actions make incident analysis cleaner.
2. **Idempotency framing** — both endpoints are idempotent: re-running with the same window + content produces the same end state. For refresh-window the framing is "we keep replacing the window with whatever aice-web-next says is authoritative." For backfill the framing is "we seed a window we never had; re-running just re-seeds with the same content." Operators understand the two intentions differently even though the receiver code is the same.

Aimer-web MAY (and is recommended to) implement both routes by sharing a single handler internally, differing only in the audit action emitted.

### Error handling

Same pattern as [#492](https://github.com/aicers/aice-web-next/issues/492):

- **400** — payload validation failure
- **401 / 403** — auth failure
- **413** — payload too large; aice-web-next splits and retries
- **429 / 5xx** — bounded retry with exponential backoff (3 attempts: 1s / 3s / 9s); after exhaustion, surface visible failure and do not advance the cursor
- **Network failure / timeout** — same as 5xx, default 30s request timeout

## Sync mechanism (aice-web-next side)

This section is internal to aice-web-next and does not constrain aimer-web. It is documented here for contract context only.

### Trigger model

| Data | Trigger |
|---|---|
| Baseline event | Periodic drain on Triage tab activation (default 5 min interval while visible) + `aimer_push_queue` drain for `withdraw_baseline_event` / `refresh_baseline_window` / `backfill_baseline_window` |
| Story | Periodic drain on Stories tab activation + per-Story manual "Send" button + `aimer_push_queue` drain for `withdraw_story` / `refresh_story_window` / `backfill_story_window` |
| Policy run | Manual "Send this run" button only |
| Policy event withdraw (queue-only) | Periodic drain on Policy mode page activation + Settings "Sync now"; drains `withdraw_policy_event` queue rows (no cursor, no new-row push) |
| Withdraw notice | Enqueued by exclusion `retroactive-delete` job under specific queue kinds (`withdraw_baseline_event`, `withdraw_policy_event`), drained by the matching kind's drain |
| Refresh notice | Enqueued by Force Rebuild routes ([#473](https://github.com/aicers/aice-web-next/issues/473), [#565](https://github.com/aicers/aice-web-next/issues/565)) under `refresh_baseline_window` / `refresh_story_window`, drained by Baseline / Story drain |
| Backfill notice | Enqueued by admin backfill route under `backfill_baseline_window` / `backfill_story_window`, drained by Baseline / Story drain (routes to `/api/phase2/backfill` not `/refresh-window`) |

### Browser-driven drain loop

Because aice-web-next servers cannot initiate outbound network calls (air-gap), the browser drives the loop. Each per-kind issue implements a `POST /api/aimer/phase2/<kind>/next-batch` route that:

1. Optionally commits the previous batch's pending advancement when the body carries `acked_context_jti` (idempotent on the `jti`).
2. Returns the next batch's signed envelope + payload + `batch_jti`, or `{ has_more: false, ...nulls }` when nothing is pending.

Foundation provides the client-side `drainOpportunisticPushQueue(kind, options)` helper ([#582](https://github.com/aicers/aice-web-next/issues/582) Foundation Client) that loops calls to `next-batch` (threading the prior `batch_jti` as `acked_context_jti`) interleaved with POSTs to aimer-web at the endpoint named by the response's `aimer_endpoint_path` field, until `has_more: false` or first failure. `kind` accepts `"baseline_event" | "story" | "policy_event"` — the third is queue-only (no cursor advancement, only `withdraw_policy_event` notice delivery). The `next-batch` contract itself ([#570](https://github.com/aicers/aice-web-next/issues/570) Foundation Server) is what each per-kind issue implements.

Cursor advancement is delayed-ack: it commits server-side on the *next* iteration's `acked_context_jti`, so any failed batch (whose response never arrives at aice-web-next, or whose retry exhausts) simply does not advance the cursor and is naturally resent on the next activation (aimer-web dedupes via `ON CONFLICT DO NOTHING` per natural key).

### Periodic re-drain (continuous background push)

Tab activation fires the initial drain; while the tab stays visible, a periodic drain (default interval 5 min, configurable) re-fires the loop so newly arrived rows propagate within minutes. The `document.visibilityState === 'hidden'` event pauses the timer; visibility return resumes it. Page unmount aborts in-flight drain cleanly (`AbortSignal`). The choice between **periodic re-drain bounded to visible tab** vs **Service Worker background** is deliberate — the visible-tab bound keeps the trust story simple ("data moves only when an authenticated user is actively present").

### Cursor

A single `(event_time, event_key)` cursor per push kind, stored in a per-customer DB state table (`aimer_push_state`):

```sql
CREATE TABLE aimer_push_state (
  -- Streaming kinds only. policy_run is manual-only and tracked via β columns on
  -- policy_triage_run directly; it does not have a cursor row here.
  kind                    TEXT        PRIMARY KEY
                          CHECK (kind IN ('baseline_event', 'story')),
  last_pushed_event_time  TIMESTAMPTZ,
  last_pushed_event_key   TEXT,
  last_synced_at          TIMESTAMPTZ,
  last_error              TEXT,
  -- pause control
  opportunistic_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  paused_at               TIMESTAMPTZ,
  paused_by               UUID
);
```

Ack tracking lives in a separate `aimer_push_inflight` table (see [#570](https://github.com/aicers/aice-web-next/issues/570)) keyed on `context_jti`, not on a `last_drained_queue_id` column on the cursor table. The inflight table makes pending advancement state shared across multiple aice-web-next instances and survives instance churn (TTL ≈ 2 min on `minted_at`).

Initial cursor on first activation: **start from "now"**. No automatic backfill of history. An admin-triggered `POST /api/phase2/backfill` from settings handles catch-up if requested.

The cursor is internal aice-web-next state — aimer-web is not aware of cursor values and the cursor format may change without affecting the wire contract.

**Cursor persists across user sessions and across customers' user base.** Cursor lives in the per-customer tenant DB, not in any user session table. Logout / session expiry / browser uninstall does not touch it. When any user with `triage:read` for the customer later opens Triage / Stories, the drain reads the unchanged cursor and resumes. Opportunistic drain attribution writes `system_actor` to β tracking columns (`last_sent_by`) regardless of which user account triggered the activation — only manual Send attributes to the clicking user. This keeps cursor + audit semantics consistent across multi-user, multi-session customer access.

### Pause control

Operators can temporarily suspend opportunistic push per kind via the `opportunistic_enabled` flag (toggled from the [#437](https://github.com/aicers/aice-web-next/issues/437) settings UI). When `FALSE`, the `next-batch` route returns `{ has_more: false, paused: true, ...nulls }` immediately — the periodic drain continues to fire on schedule but each iteration is a no-op. Queued notices accumulate and drain when the flag is flipped back to `TRUE`. Manual Send is unaffected (by design: pause is for the background flow only). The toggle records `paused_at` + `paused_by` for audit traceability.

### Push queue (durable, ack-driven)

`aimer_push_queue` table holds pending withdraw and refresh notices written by retroactive-delete and Force Rebuild jobs. Drained on opportunistic push alongside new-row push.

**Durability rule**: queue rows are **never auto-expired**. A withdraw or refresh notice that has not been ack'd by aimer-web stays in the queue until it is, because losing one means leaving stale data in aimer-web indefinitely. The "no one active for long periods" case is handled by the visibility rules below, not by silent expiry.

```sql
CREATE TABLE aimer_push_queue (
  id BIGSERIAL PRIMARY KEY,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Specific kind discriminator: each value maps 1:1 to one aimer-web endpoint +
  -- one schema_version. This avoids inspecting payload to decide where to deliver.
  kind TEXT NOT NULL CHECK (kind IN (
    'withdraw_baseline_event',     -- → POST /api/phase2/withdraw (baseline_event withdrawals)
    'withdraw_story',              -- → POST /api/phase2/withdraw (story withdrawals)
    'withdraw_policy_event',       -- → POST /api/phase2/withdraw (policy_event withdrawals)
    'refresh_baseline_window',     -- → POST /api/phase2/refresh-window (baseline window)
    'refresh_story_window',        -- → POST /api/phase2/refresh-window (story window)
    'backfill_baseline_window',    -- → POST /api/phase2/backfill (baseline window)
    'backfill_story_window'        -- → POST /api/phase2/backfill (story window)
  )),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  acked_at TIMESTAMPTZ,
  acked_context_jti TEXT
);
CREATE INDEX idx_aimer_push_queue_pending ON aimer_push_queue (id) WHERE acked_at IS NULL;
```

**Drain ownership by kind**:

| Queue kind | Drained by |
|---|---|
| `withdraw_baseline_event`, `refresh_baseline_window`, `backfill_baseline_window` | [#571](https://github.com/aicers/aice-web-next/issues/571) Baseline drain (Triage tab periodic) |
| `withdraw_story`, `refresh_story_window`, `backfill_story_window` | [#493](https://github.com/aicers/aice-web-next/issues/493) Story drain (Stories tab periodic) |
| `withdraw_policy_event` | [#572](https://github.com/aicers/aice-web-next/issues/572) Policy drain (Policy mode page activation + Sync now) |

The "Sync now" button in Settings ([#574](https://github.com/aicers/aice-web-next/issues/574)) invokes **all three drains** so an operator can guarantee a fully empty queue with one click — particularly relevant for `withdraw_policy_event`, which depends on someone visiting the Policy mode page (rarer than Triage / Stories tab visits).

A queue row is considered drained when `acked_at IS NOT NULL`. Drained rows are kept for a configurable audit window (default 30 days) then physically deleted.

**Ack flow**: each push call returns `context_jti` and `received_at`. aice-web-next records `acked_at = NOW()` and `acked_context_jti = response.context_jti` on the successful queue row(s). New-row pushes likewise advance `aimer_push_state.last_synced_at` only on ack.

**Visibility when queue grows**: settings status indicator surfaces `pending_count` and `oldest_pending_age` from `aimer_push_queue WHERE acked_at IS NULL`. Once `oldest_pending_age` crosses a threshold (e.g., 24 hours), the indicator turns yellow and prompts the operator to either visit Triage/Stories tab to drain or invoke the manual "Sync now" affordance. This makes queue staleness visible rather than silently swept under retention.

**Reconciliation**: the manual "Sync now" affordance does (a) drain the entire queue end-to-end, (b) push any new rows since the cursor, and (c) emit a one-shot integrity audit (counts of `aimer_push_queue WHERE acked_at IS NULL` before/after). For deeper drift recovery, the operator can also invoke `POST /api/phase2/backfill` for a specific window which will fully replace aimer-web's content for that window — useful if aimer-web reports row counts inconsistent with aice-web-next's view.

### Reliability & recovery

Failure handling is unified across all interruption sources by the same primitives: server-side inflight TTL + natural-key idempotency on aimer-web side + monotonic cursor advancement only on ack. Concretely:

- **Mid-loop browser close / tab navigation / network drop**: in-flight inflight record expires by TTL (~2 min); cursor stays at prior value; next activation re-sends the same slice; aimer-web's `ON CONFLICT DO NOTHING` dedupes. No data loss, no duplicate storage. The four sub-cases (response received pre-POST / pre-2xx / post-2xx-pre-ack / mid-transaction) all converge identically.
- **Long offline period**: cursor persistence in the customer DB makes resumption a non-event — any user with `triage:read` for the customer who opens Triage / Stories later picks up where the cursor left off. Backlog catch-up is bounded per activation by `maxBatchesPerActivation` (default 100); the Settings indicator's bucket label visibly tracks "way_behind" until catch-up completes.
- **Retention boundary**: if the cursor falls behind the baseline retention window (30 days per RFC 0001 §7), rows deleted by retention before being sent are **never sent**. This is by design — opportunistic push is best-effort. Full historical coverage requires explicit operator backfill via `POST /api/phase2/backfill`. The Settings indicator's "behind" / "way_behind" buckets surface this well before the retention cliff.
- **Trust key rotation across the gap**: [#437](https://github.com/aicers/aice-web-next/issues/437) keypair rotation is transparent — the next drain mints tokens with the new key, aimer-web verifies via the updated `trust_registry` entry. No operator action needed.
- **Cross-side verification**: aimer-web's batch ingest emits an `aimer_phase2.ingest` audit row per successful ingest, carrying the `contextJti` from the matching aice-web-next envelope. The two sides' logs correlate by `contextJti` for forensic "did this batch make it?" questions. aice-web-next does NOT poll aimer-web for verification (the one-way air-gap forbids return channels); drift converges through idempotent re-send.

### Backlog estimation

For the Settings indicator to show "how far behind is the push?", the server provides a cheap approximate estimate per kind via `estimateBacklog(customer_id, kind)`. The result is a coarse `BacklogEstimate { bucket, approximate_count, cursor_lag_seconds, pending_notice_count }` with bucket buckets `synced` / `behind` / `way_behind` / `paused`. Thresholds are intentionally coarse — exact counts are expensive on large tables and not actionable. The bucket is always present; the count may be `null` if even a coarse query is too expensive.

## Storage routing & analysis lookup precedence

### Send-side routing (aice-web-next)

A "Send this event to aimer-web" button on a Detection-menu event row routes to:

- **Phase 2 channel** if the event is currently baseline-passing (i.e., a row exists in `baseline_triaged_event` for this `event_key`). The send button triggers an immediate Phase 2 push that includes this event (and possibly its small batch context), bypassing the wait for the next opportunistic cycle.
- **Phase 1 channel** (existing `detection_events` bridge handoff) if the event is **not** baseline-passing.

This guarantees a baseline-passing event is **never** stored in `detection_events` going forward. Pre-existing `detection_events` rows for events that later become baseline-passing (e.g., due to a `baseline_version` bump that re-classifies them) are not migrated; the lookup precedence rule below handles them transparently.

### Read-side lookup (aimer-web)

**v1 scope: Phase 2 lookup only.** When the analysis surface is asked to display analysis for a specific `(external_key, event_key)`:

1. Look up `baseline_event` (Phase 2) — if present, use this row's data and `analysis_narrative`. Returns rich window-level signals + asset context + Phase 2 LLM analysis.
2. Else return "no analysis available".

**Phase 1 `detection_events` is NOT searchable by `event_key` in v1.** The Phase 1 row's payload is an encrypted BYTEA blob and aimer-web does not maintain a plaintext `event_key` index on it. Looking up by event_key would require per-row decryption, which is not viable at query time. Phase 1 rows are reachable only through Phase 1-native surfaces (the Detection bridge audit log, or a future Phase 1-specific list page) by their internal `detection_events.id`, not by `event_key`.

**Pre-existing `detection_events` rows for events that later become baseline-passing** stay in `detection_events` as historical record but are invisible to the by-event_key lookup. When the Phase 2 row arrives via re-classification + opportunistic push, it becomes the canonical analysis view; the Phase 1 row is harmless dark storage.

If a future need arises to surface Phase 1 rows by `event_key`, the path is to add a plaintext `event_key` index column to `detection_events` (or a sibling index table) and extend the lookup — additive RFC change, out of v1 scope. Tracked as a known limitation, not a bug. (See [aicers/aimer-web#220](https://github.com/aicers/aimer-web/issues/220) for the v1 implementation.)

## Trigger UX & consent model

### Opportunistic trigger

Push fires on Triage / Stories tab activation in aice-web-next, AND periodically (default 5 min) while the tab stays visible. Visibility-hidden pauses the timer; visibility return resumes. **No Service Worker / true background** — periodic re-drain is intentionally bounded to the visible-tab lifetime to keep the trust story simple (data moves only while an authenticated user is actively present). The `aimer_push_queue` is drained as part of the same push calls.

### Manual trigger surfaces

- **Story 1 row**: per-Story "Send to aimer-web" button on the Stories tab ([#493](https://github.com/aicers/aice-web-next/issues/493))
- **Policy run**: "Send this run to aimer-web" button on the policy run detail page (required — Policy is on-demand only)
- **Baseline event**: no per-row manual button (opportunistic covers it). Operator-level "Sync now" affordance lives in [#437](https://github.com/aicers/aice-web-next/issues/437) settings page

### Consent model

One-time consent in [#437](https://github.com/aicers/aice-web-next/issues/437) Aimer integration settings. Covers:

- Enabling opportunistic push for Baseline + Story
- Data scope: "REview-derived metadata + aice-web-next-computed signals; raw packet bytes excluded"
- Future scope changes (e.g., adding raw packets, redaction toggle changes) require re-consent

Manual button clicks are themselves the per-action consent — no extra dialog. The Policy-run Send button is a per-run consent.

### Visibility (approximate, bucket-based)

The operator's view of sync health is deliberately coarse — exact counts are not the goal, "is the system OK / behind / way behind / paused" is. Settings → Aimer integration shows **three display tracks** mirroring the underlying model:

- **Streaming kinds** (`baseline_event`, `story`) — bucket label (synced / behind / way_behind / paused) from `estimateBacklog` + approximate backlog text (`~12,000 events, ~2 hours behind` or `caught up`) + pause toggle + Sync now. These have cursors in `aimer_push_state` and pause semantics.
- **Manual-only kind** (`policy_run`) — "Last sent run" + "Total runs sent" from `policy_triage_run` β columns. No bucket / cursor / pause.
- **Queue-only kind** (`policy_event`) — pending count of `withdraw_policy_event` rows + most recent unack'd row's `last_error`. No bucket / cursor / pause; cleared on successful drain via Policy mode page activation or Sync now.

Plus cross-cutting surfaces:

- **Live drain progress**: when a drain is in flight (from tab activation, periodic timer, or "Sync now"), the Settings page shows a spinner + `"Syncing baseline events… batch 3 of ~12"`. The "~N" is approximate.
- **Login banner**: on any aice-web-next page load (post-login), if any kind is in a non-synced state, the app shell shows a one-line summary banner. Addresses "did I miss anything while I was away?" without forcing navigation to Settings.
- **Per-row β tracking**: Story and Policy run get per-row `last_sent_at` / `send_count` / `last_sent_by` columns surfaced in their respective tables (Story cards, Policy run detail). Baseline event has no per-row indicator — the tab-level bucket is the only baseline-event visibility.
- **Audit log**: a "send history" page in settings is a possible follow-up if operators ask for full chronological view; the cross-side `aimer_phase2.ingest` audit on aimer-web is the canonical history in the meantime.

### Pause control

A per-kind toggle in Settings → Aimer integration page flips `opportunistic_enabled` for that kind (Baseline / Story). When paused, the periodic drain becomes a no-op (still polls; each call returns immediately), pending notices accumulate, and the bucket label shows "paused" with `paused_at` + `paused_by` tooltip. Manual Send is unaffected. Resume restores normal flow. Operator use cases: aimer-web maintenance windows, rolling out a fix to a noisy payload bug, compliance snapshot reviews.

### Failure handling

Bounded retry (3 attempts) on 429 / 5xx / network failures, then visible failure surfaced in the settings status indicator with the last error message. Same pattern as [#492](https://github.com/aicers/aice-web-next/issues/492). Cursor does not advance on failure.

## Future: cross-customer Story (deferred)

Cross-customer Story analysis — where a Story's member set spans events from multiple customers — is deferred to a separate Phase 3 RFC. It requires:

- A new `system_db` tier on both aice-web-next and aimer-web (System Administrator scope, separate from per-customer DBs)
- Customer-level opt-in flag for cross-correlation participation
- Audit trail showing each customer when their data participated in cross analysis
- A separate push channel (`POST /api/phase3/cross-story/...`) with System Admin authority and its own consent model

This RFC's identifier policy (always-tuple keys including `external_key`) is forward-compatible: a Phase 3 cross-Story member references its source event as `(external_key, event_key)` exactly as Phase 2 already does. No migration of Phase 2 data is anticipated when Phase 3 lands.

## Resolved decisions

The three items previously listed as "Must resolve before Accepted" are now resolved in-document; this section records the conclusions for traceability.

- **Envelope format** — §6.1 pins the actual current Phase 1 wire format: multipart/form-data with `context_token` (ES256 JWS), `events_envelope` (ES256 JWS with `payload_hash` of events_data, `schema_version`, `context_jti` linking to context token), and `events_data` (the JSON payload bytes). Phase 2 introduces no new crypto and no new claim set — `schema_version` strings (`phase2.baseline.v1`, etc.) discriminate inner-payload shapes. The Phase 2 ingestion path uses the same multipart + verification but **bypasses** the Phase 1 staged-events workflow, INSERTing directly into the Phase 2 tables (§5). Aimer-web work item: extract `verifyContextToken` / `verifyEventsEnvelope` calls and downstream routing into a shared helper so Phase 2 route handlers can reuse without copy-pasting the Phase 1 bridge route.

- **Cohort form precision in `score_window_context`** — Simplified to `{ kind_cohort_window, kind_cohort_size, baseline_rank_snapshot }`. Quantile arrays and `kind_cohort_score_max` are NOT sent. Reports use `baseline_rank_snapshot` as the canonical "ranking the analyst saw at push time." Cross-window ranking is out of this version's contract; if future report needs require it, add it as an additive RFC extension (full cohort distribution, or aimer-web-side `CUME_DIST` over accumulated corpus).

- **`context_jti` echo-back** — Confirmed in response body of every §6 endpoint. Echoes the context token's `jti` so aice-web-next can match the response to the originating queued push. No security implication (envelope was already verified upstream; `jti` is not a secret).

## Open questions (implementation-time)

These can be decided by either team during PR work without changing the wire contract or the other side's implementation.

1. **Encryption-at-rest for new Phase 2 tables.** aimer-web's existing pattern (BYTEA + wrapped DEK + Transit envelope) is robust but query-hostile. Options: (a) full encryption like `detection_events` (forces narrow indexed columns to be plaintext duplicates); (b) selective encryption of sensitive payload fields only; (c) plaintext with DB-level encryption (TDE / disk-level). Affects index design and query patterns but not the wire contract.

2. **`analysis_narrative` cache scope.** Per-event narratives, per-Story narratives, per-policy-run narratives, per-report narratives — do they share one `analysis_narrative` table keyed by `content_hash`, or are they separated by `target_kind`? Affects aimer-web cache invalidation logic when underlying data changes; aice-web-next is unaware.

3. **aimer-web side retention.** Does aimer-web mirror aice-web-next's retention windows (Baseline 30d / 180d, Story TBD per [#461](https://github.com/aicers/aice-web-next/issues/461)) or hold longer for historical analysis? Withdraw notices apply either way; this only affects how long aimer-web keeps analyses past the source's retention.

4. **Payload size budget.** aimer-web already enforces a configurable cap via `BRIDGE_MAX_PAYLOAD_BYTES` env var (default 50 MB) on `events_data`. Phase 2 inherits this without change. aice-web-next needs to read the same value (either from a system setting in [#437](https://github.com/aicers/aice-web-next/issues/437) UI synchronized with aimer-web's env, or from a constant pinned in both repos) so it can pre-emptively split large batches. Cross-PR coordination at merge time: agree on whether aice-web-next reads from a setting or a constant, and what value matches aimer-web's default.

5. **Window-signal computation cost on aice-web-next side.** Whether to cache stats in a new `aimer_push_stats_cache` table is an aice-web-next implementation question. Affects push cadence density but not the wire contract.

6. **Send button race during baseline re-classification.** When a `baseline_version` bump re-classifies a previously baseline-failing event as baseline-passing, the existing Phase 1 `detection_events` row stays. The lookup precedence handles display correctly. Whether to also emit an explicit "demote Phase 1 row" notice for storage cleanup is an optimization that can be added later.

7. **Sibling system setting for Phase 2 base URL.** §6.1 defaults to reusing `aimer_web_bridge_url`. If Phase 2 ever needs a separate base URL, the resolution is to add a sibling system setting in [#437](https://github.com/aicers/aice-web-next/issues/437) UI. This is a [#437](https://github.com/aicers/aice-web-next/issues/437) UI extension that can be made when the need actually appears, not now.

8. **`policy_run.owner_account_id` cross-tenant resolution.** The wire payload exposes `owner_account_id` (UUID referencing `auth_db.accounts(id)`). aimer-web's `auth_db` is separate, so this UUID is not directly resolvable on aimer-web side. Whether aimer-web surfaces it (and if so, with what enrichment) is aimer-web's display decision; aice-web-next sends the UUID either way.

## Future RFC extensions (not in this version)

- Cross-window ranking support for baseline events (extend `score_window_context` or add aimer-web-side recomputation).
- Cross-customer Story analysis (Phase 3 — see §10).
- Multi-window LLM packaging ([#495](https://github.com/aicers/aice-web-next/issues/495)).
- Approval workflow before Send ([#494](https://github.com/aicers/aice-web-next/issues/494)).
- Privacy-related field redaction.

## References

- aice-web-next umbrella: [#491](https://github.com/aicers/aice-web-next/issues/491)
- Phase 1 single-event send: [#441](https://github.com/aicers/aice-web-next/issues/441)
- Existing draft contract: [#492](https://github.com/aicers/aice-web-next/issues/492)
- Story schema and correlator: [#489](https://github.com/aicers/aice-web-next/issues/489), [`src/lib/triage/story/`](src/lib/triage/story/)
- Baseline algorithm: [RFC 0001](rfcs/0001-baseline-algorithm.md), [#462](https://github.com/aicers/aice-web-next/issues/462)
- Force Rebuild (Baseline): [#473](https://github.com/aicers/aice-web-next/issues/473)
- Force Rebuild (Story): [#565](https://github.com/aicers/aice-web-next/issues/565)
- aimer-web integration settings: [#437](https://github.com/aicers/aice-web-next/issues/437)
- Customer external_key: [#438](https://github.com/aicers/aice-web-next/issues/438)
- aimer-web bridge handoff hardening: [aimer-web#197](https://github.com/aicers/aimer-web/issues/197)
