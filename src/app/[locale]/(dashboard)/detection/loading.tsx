import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";

/**
 * Route-level loading UI for `/detection` (#751).
 *
 * The Detection page is a server component that blocks on a heavy
 * `searchEventsAtAnchor` query before returning any HTML, so without a
 * `loading.tsx` the App Router keeps the previous screen on display
 * until the SSR query resolves — the UI looks frozen for the whole
 * wait, which is especially long when the restored tab carries a heavy
 * window (e.g. "last 3 years").
 *
 * This renders an immediate skeleton of the detection shell (filter bar
 * + result area) the instant the navigation commits. The result area
 * reuses the in-shell loading panel's visual language — a spinning
 * `RefreshCw` over the existing `detection.results.loadingTitle` /
 * `loadingDescription` copy (no new i18n keys) — so the skeleton and
 * the live loading state read as the same surface.
 */
export default async function DetectionLoading() {
  const t = await getTranslations("detection");

  return (
    <div className="flex gap-4" aria-busy="true">
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <h1 className="sr-only">{t("title")}</h1>

        {/* Top bar skeleton — mirrors the live shell's Filters button +
            presets dropdown + active-chip toolbar so the layout does
            not jump when the real shell takes over. */}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm opacity-60">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {t("filters.open")}
          </span>
          <Bar className="h-8 w-28" />
          <div className="min-h-8 flex-1 rounded-md border border-dashed border-[var(--sidebar-border)] px-3 py-1" />
        </div>

        {/* Result area — same StatePanel shape the result list renders
            while a query is in flight. */}
        <div className="flex min-h-[60vh] flex-1 gap-4">
          <section className="flex min-w-0 flex-1 flex-col">
            <div
              role="status"
              aria-live="polite"
              className={cn(
                "bg-card flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-lg border p-6 text-center",
                "border-[var(--sidebar-border)] text-muted-foreground",
              )}
            >
              <RefreshCw className="size-8 animate-spin" aria-hidden="true" />
              <div className="flex flex-col gap-1">
                <p className="text-foreground text-sm font-medium">
                  {t("results.loadingTitle")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("results.loadingDescription")}
                </p>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function Bar({ className }: { className?: string }) {
  return (
    <span
      className={cn("bg-muted inline-block animate-pulse rounded", className)}
      aria-hidden="true"
    />
  );
}
