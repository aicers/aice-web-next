"use client";

/**
 * Fire-and-forget client helpers for `POST /api/triage/engagement`.
 *
 * Per #588 acceptance: "Ingestion failures **never block** the Triage
 * UI (fire-and-forget on the client)." Every helper here returns
 * `void` synchronously and swallows network / parsing / response
 * errors. Errors land on `console.error` so they remain debuggable
 * in HAR / DevTools without affecting the UI.
 *
 * Why two transport choices. The Fetch spec caps `keepalive: true`
 * requests at a 64 KiB total body budget per page (Fetch Standard
 * §4.4.6 / processing-model step "navigation/unload safety"). Action
 * posts are single-row JSON (well under the cap) and can fire right
 * before a navigation, so they keep `keepalive` so a fast click +
 * navigate still reaches the server. Impression batches carry every
 * surfaced row in a menu load — up to `TRIAGE_HARD_EVENT_CAP +
 * STORY_PROTECTED_HARD_CAP = 7,000` rows — which can blow past 64 KiB
 * for the larger menus, so the batch fires WITHOUT `keepalive`. The
 * impression POST happens inside a `useEffect` after the menu has
 * already rendered, so the in-flight request survives Next.js client-
 * side navigation without `keepalive` (only a full unload would drop
 * it, which is acceptable for the batch denominator).
 */

import { mutatingFetch } from "@/lib/csrf-client";

import type { EngagementAction, EngagementImpressionBatch } from "./types";

const ENGAGEMENT_URL = "/api/triage/engagement";

function fire(body: unknown, options: { keepalive: boolean }): void {
  // The browser `fetch` returns a promise; intentionally do NOT await
  // it so the caller can continue rendering. A failed promise is
  // caught and logged but never propagated.
  mutatingFetch(ENGAGEMENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: options.keepalive,
  }).catch((err) => {
    console.error("[engagement] post failed", err);
  });
}

/**
 * Fire one impression batch. Idempotent server-side per the schema's
 * `UNIQUE (menu_load_id, event_key)` — a stale duplicate replay is a
 * no-op.
 *
 * Sent **without** `keepalive` so the body is not subject to the 64
 * KiB keepalive cap — the worst-case menu (≈7,000 rows) cannot fit
 * under that cap and the server would otherwise reject the request,
 * dropping the Phase 2 denominator on exactly the menus where it
 * matters most.
 */
export function postImpressionBatch(batch: EngagementImpressionBatch): void {
  if (batch.impressions.length === 0) return;
  fire({ kind: "impressions", ...batch }, { keepalive: false });
}

/**
 * Fire one engagement action. Sent **with** `keepalive` so a click
 * that immediately navigates away (e.g. asset select → detail page)
 * does not strand the action row in flight. The single-row body is
 * well under the 64 KiB keepalive cap.
 */
export function postEngagementAction(action: EngagementAction): void {
  fire({ kind: "action", action }, { keepalive: true });
}
