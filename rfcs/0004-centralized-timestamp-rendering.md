# RFC 0004: Centralized, client-resolved timestamp rendering

- Status: **Accepted**
- Authors: @sehkone
- Tracks: [#761](https://github.com/aicers/aice-web-next/issues/761)
- Related: aimer-web [#555](https://github.com/aicers/aimer-web/issues/555) (the aimer-side reference implementation — UTC-flash rework); aice-web-next `src/lib/format-date.ts`

## Summary

aice-web-next renders timestamps by calling `formatDateTime` / `formatDateTimeCompact` **inline** at 32 production call sites across 22 component files (31 `formatDateTime` + 1 `formatDateTimeCompact`, measured 2026-06). aimer-web instead centralizes all timestamp rendering behind a single `<Timestamp>` component. The two products diverge in *mechanism* without a principled reason — the divergence is a historical accident of each app's data-loading shape, not a design choice.

This RFC proposes aice-web-next converge onto the same **centralized, client-resolved** timestamp design that aimer adopts (after its UTC-flash rework): one component that resolves timezone + locale on the client behind a **layout-stable placeholder**, never server-rendering a timezone/locale-dependent value — plus a **string-returning hook** for the call sites that consume the formatted value as data rather than JSX. The shared **format contract** already exists (`formatDateTime` / `formatDateTimeCompact`); this RFC is about the **rendering mechanism**, not the format.

## Motivation

1. **No single source of truth.** With `formatDateTime` called inline at every one of the 32 sites, the timezone wiring (`useTimezone()`) and option choices are repeated at every call. A future behavior change (e.g. the parity work aimer just did) touches all of them instead of one place. aimer's centralized component made the analogous format change a 2-file edit.
2. **Hydration safety is partial and hand-rolled.** Most timestamp-bearing components fetch data client-side, so their values are not in SSR HTML — but not all. The event-detail page is a server component that fetches the event and passes it as props to the client `EventInvestigation`, which formats `event.time` immediately: those timestamps **are** in SSR HTML today, with no guard. `TimezoneProvider` initializes from `Intl.DateTimeFormat().resolvedOptions().timeZone`, which resolves to the **server's** timezone during SSR, so whenever the server's TZ — or its ICU locale, via `toLocaleString(undefined, …)` — differs from the browser's, that path mismatches on hydration. Meanwhile the node surfaces (`node-status-table`, `resource-sparkline`, `node-detail-dashboard`) each hand-roll their own deferred-after-hydration guard (`hydrated` state / `useEffect`-set labels) — exactly the mechanism this RFC centralizes, currently duplicated per site. There is no shared guard; safety rests on per-site convention.
3. **Consistency across the product family.** aimer and aice should render the same instant the same way and handle hydration the same way, not by two different mechanisms.
4. **Enables a future user-selectable time format.** The format matched today (vs aimer-web) is a *default*. A likely future direction is letting the user choose among options — 12-hour vs 24-hour, with/without seconds, with/without an explicit timezone label, locale source — as an account preference (aimer-web tracks the parallel at aicers/aimer-web#556). With every call site inlined that would mean editing all of them; behind one component it is a single, central change. This RFC does **not** build such a preference, but centralizing is what keeps the door open for it (see Non-goals).

## Design

- **One component** (e.g. `<Timestamp>` / a compact variant), backed by the existing `src/lib/format-date.ts` formatters (unchanged).
- **A string-returning hook alongside the component** (e.g. `useTimestampString`). A subset of call sites consumes the formatted value as **data**, not JSX, and cannot render a component: the shared `TriageEventTable` row contract (`stories-view`, `asset-detail` — caller-side formatting is contractual there), the breadcrumb label (`event-breadcrumb-registrar`, the sole `formatDateTimeCompact` site), chart/progress labels (`resource-sparkline`, `node-detail-dashboard`), and template-literal labels (`webauthn-card`). Those sites migrate to the hook or explicitly stay on the raw formatter; the migration plan must mark which, per site. The hook applies the same pre-mount deferral, but a bare string cannot carry the component's placeholder guarantees (`visibility: hidden`, `aria-hidden`, `<time dateTime>`) — so it returns resolution state rather than a magic placeholder string (e.g. `{ text, resolved, dateTime }`), and the caller owns whatever wrapper/announcement semantics its context allows. The acceptance criteria below bind the **component**, not hook consumers.
- **Client-resolved with a layout-stable placeholder:** pre-mount (server + first client paint) render a deterministic, fixed-footprint placeholder (fixed width / `visibility: hidden` / sized skeleton); post-mount render the resolved value. This mirrors aimer's reworked `<Timestamp>`: no UTC detour, no value flash, and no hydration mismatch by construction (nothing tz/locale-dependent is ever in SSR HTML).
- **Placeholder acceptance criteria (for the component):** (a) **fixed footprint** — placeholder and resolved value occupy the same box, no layout shift (CLS) on resolution; (b) **accessibility** — the placeholder is not announced as content (e.g. `aria-hidden` until resolved), and the resolved value renders a semantic `<time dateTime={iso}>` so assistive tech gets the machine-readable instant; (c) **no value flash** — never paint a UTC or server-zone value first.
- **Inputs unchanged:** timezone from the existing `TimezoneProvider` (account → browser); locale general = browser (`undefined`), compact = `useLocale()` — exactly today's formatter contract.

## Migration

- Replace the 32 inline `formatDateTime` / `formatDateTimeCompact` call sites (22 files): JSX render sites take `<Timestamp>`; string-as-data sites take the hook (or are explicitly marked as staying on the raw formatter). Mechanical but broad; stage by area (audit, dashboard, events, accounts, …) to keep PRs reviewable.
- Remove the hand-rolled hydration guards on the node surfaces (`node-status-table`, `resource-sparkline`, `node-detail-dashboard`) in the same change that migrates those sites — the central mechanism subsumes them.
- Keep the formatter functions — the component uses them internally; their unit tests stay.
- Visual review per area to catch spacing/wrapper regressions where inline calls had bespoke markup.

## Non-goals

- Changing the **display format** — already shared with aimer-web; not in scope.
- A shared cross-repo package — the two apps are separate repos, so the component is **duplicated by design** (same shape, not shared code).
- Changing the timezone **resolution** policy (account → browser stays).
- Building a **user-selectable time-format preference** — out of scope here. This RFC only keeps the door open for it by centralizing the format in one place; no preference UI or option plumbing is introduced. The design constraint that follows: do not leak format decisions (option objects, hard-coded `Intl` choices) back into call sites — keep them in the single component/formatter.

## Trade-offs / risks

- **Churn vs. value.** A 32-site refactor of a working system. The benefit is consistency, lower future-change cost, and replacing per-site (and partly missing) hydration guards with a structural guarantee — the only currently-latent defect is the unguarded event-detail SSR path, which surfaces only when server and browser TZ/locale differ. This churn-vs-value trade-off was the central consideration, weighed and resolved in favour of adoption (see Decision).
- **Layout regressions.** Inline call sites may have bespoke wrappers; centralizing risks small spacing/alignment changes. Mitigated by staged migration + per-area visual review.

## Decision

**Adopted (2026-06-12).** The deciding argument is that the unguarded event-detail SSR path is debt owed regardless of this RFC: server containers typically run UTC while operator browsers run a local zone, so the mismatching combination is the *typical* deployment, and fixing it without centralizing would mean hand-rolling a fourth per-site hydration guard. Centralizing pays that debt structurally, and keeps the door open for the user-selectable format preference (aimer-web#556).

The declined alternative — keep the inline mechanism and add a one-off guard to event detail — was rejected as repeating exactly the per-site duplication this RFC removes.

Execution order: wait for the aimer-side reference implementation (aicers/aimer-web#555) to land and settle the placeholder design; then fix the shared API shape (`<Timestamp>` + the string-returning hook); then run the staged per-area call-site migration.
