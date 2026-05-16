"use client";

/**
 * Fire-and-forget client helpers for `POST /api/triage/engagement`.
 *
 * Per #588 acceptance: "Ingestion failures **never block** the Triage
 * UI (fire-and-forget on the client)." Every helper here returns
 * `void` synchronously and swallows network / parsing / response
 * errors. Errors land on `console.error` so they remain debuggable
 * in HAR / DevTools without affecting the UI.
 */

import { mutatingFetch } from "@/lib/csrf-client";

import type { EngagementAction, EngagementImpressionBatch } from "./types";

const ENGAGEMENT_URL = "/api/triage/engagement";

function fire(body: unknown): void {
  // The browser `fetch` returns a promise; intentionally do NOT await
  // it so the caller can continue rendering. A failed promise is
  // caught and logged but never propagated.
  mutatingFetch(ENGAGEMENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // `keepalive` lets the request finish even if the user navigates
    // away mid-flight (e.g. the menu was a stepping-stone to the
    // detail page). Without it a fast click + navigate would drop
    // the impression batch entirely.
    keepalive: true,
  }).catch((err) => {
    console.error("[engagement] post failed", err);
  });
}

/**
 * Fire one impression batch. Idempotent server-side per the schema's
 * `UNIQUE (menu_load_id, event_key)` — a stale duplicate replay is a
 * no-op.
 */
export function postImpressionBatch(batch: EngagementImpressionBatch): void {
  if (batch.impressions.length === 0) return;
  fire({ kind: "impressions", ...batch });
}

/** Fire one engagement action. */
export function postEngagementAction(action: EngagementAction): void {
  fire({ kind: "action", action });
}
