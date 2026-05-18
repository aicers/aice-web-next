"use client";

import { AlertCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Link } from "@/i18n/navigation";

/**
 * App-shell login banner for #620 §1 "App-shell login banner".
 *
 * Fetches `/api/aimer/phase2/status/summary` after first paint and
 * renders a one-line summary when any customer is `behind` /
 * `way_behind` / `paused`. The fetch is deliberately client-side and
 * intentionally NOT awaited during SSR so a slow summary computation
 * never blocks initial document render (a delayed banner is acceptable;
 * a delayed page is not).
 *
 * Mounted only for sessions that satisfy `isSystemAdministrator`, so
 * the network request is not even attempted for non-admins (the route
 * itself also gates with the same check as a defense-in-depth).
 *
 * The user can dismiss the banner for the current page; reload or
 * navigation re-fetches and shows it again if the condition still
 * holds — this is intentional, the banner is not a notification that
 * should be permanently suppressed.
 */

interface SummaryEntry {
  customer_id: number;
  worst_bucket: "behind" | "way_behind" | "paused";
  kinds: ("baseline_event" | "story" | "policy_event")[];
  paused_kinds: ("baseline_event" | "story")[];
}

interface SummaryDto {
  customers: SummaryEntry[];
}

export function AimerPhase2Banner() {
  const t = useTranslations("loginBanner.phase2Sync");
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/aimer/phase2/status/summary", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as SummaryDto;
      })
      .then((dto) => {
        if (dto) setSummary(dto);
      })
      .catch(() => {
        // Swallow: banner is best-effort and must not surface failures
        // on the app shell.
      });
    return () => controller.abort();
  }, []);

  if (dismissed) return null;
  if (!summary || summary.customers.length === 0) return null;

  const worstSeverity = summary.customers.reduce((acc, c) => {
    const score =
      c.worst_bucket === "way_behind" ? 3 : c.worst_bucket === "behind" ? 2 : 1;
    return Math.max(acc, score);
  }, 0);
  const tone =
    worstSeverity === 3
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : worstSeverity === 2
        ? "border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
        : "border-muted-foreground/20 bg-muted text-muted-foreground";

  const worstBucket: "way_behind" | "behind" | "paused" =
    worstSeverity === 3
      ? "way_behind"
      : worstSeverity === 2
        ? "behind"
        : "paused";

  const kindLabels: string[] = [];
  const seenKinds = new Set<string>();
  for (const c of summary.customers) {
    for (const k of c.kinds) {
      if (!seenKinds.has(k)) {
        seenKinds.add(k);
        kindLabels.push(t(`kinds.${k}`));
      }
    }
  }
  // Show the "paused kinds" marker whenever ANY customer has at least
  // one paused contributing kind — not only when `worst_bucket` itself
  // is `paused`. Pause ranks below behind/way_behind in severity, so a
  // customer with a paused baseline and a way-behind policy_event
  // reports `worst_bucket = "way_behind"`; gating the marker on the
  // worst bucket alone would silently drop the pause signal in that
  // mixed-state case.
  if (
    summary.customers.some(
      (c) => c.worst_bucket === "paused" || c.paused_kinds.length > 0,
    )
  ) {
    if (!seenKinds.has("__paused__")) {
      seenKinds.add("__paused__");
      kindLabels.push(t("kinds.paused"));
    }
  }
  // ICU has no built-in `listFormat`; assemble a locale-friendly join
  // via comma — the surrounding `summary` key wraps it in parentheses
  // so a single comma list reads naturally in both EN and KR.
  const kindsLine = kindLabels.join(", ");

  return (
    <div
      data-testid="aimer-phase2-login-banner"
      className={`flex items-center justify-between gap-3 border-b px-6 py-2 text-sm ${tone}`}
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 shrink-0" />
        <span>
          {t("summary", {
            count: summary.customers.length,
            worst: t(`worstLabel.${worstBucket}`),
            kinds: kindsLine,
          })}{" "}
          <Link
            href="/settings/aimer-integration"
            className="font-medium underline"
          >
            {t("openSettings")}
          </Link>
        </span>
      </div>
      <button
        type="button"
        aria-label={t("dismiss")}
        className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
