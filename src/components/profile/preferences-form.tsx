"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRefreshAccountPreferences } from "@/components/providers/account-preferences-provider";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/format-date";
import {
  CURATED_TIME_FORMAT_LOCALES,
  resolveTimeFormat,
  type StoredTimeFormat,
  TIME_FORMAT_LOCALE_APP,
} from "@/lib/time-format";

// ── Constants ───────────────────────────────────────────────────

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  ko: "한국어",
};

/** Sentinel select values for the formatting-locale control. */
const TF_LOCALE_BROWSER = "browser";

/**
 * Fixed sample instant for the live preview — a PM time with non-zero
 * seconds so the hour-cycle, seconds, and AM/PM differences are visible.
 */
const PREVIEW_INSTANT = new Date("2026-01-15T13:09:05Z");

// ── Component ───────────────────────────────────────────────────

export function PreferencesForm() {
  const t = useTranslations("profile");
  const router = useRouter();
  const committedLocale = useLocale();
  const refreshPreferences = useRefreshAccountPreferences();

  const [locale, setLocale] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");
  const [timezones, setTimezones] = useState<string[]>([]);
  // Time-format controls (#766). Stored as select-friendly strings and
  // mapped to the nullable API contract on save.
  const [tfLocale, setTfLocale] = useState<string>(TF_LOCALE_BROWSER);
  const [tfHourCycle, setTfHourCycle] = useState<string>("auto");
  const [tfSeconds, setTfSeconds] = useState<string>("show");
  const [tfTzLabel, setTfTzLabel] = useState<string>("hide");
  // Raw boolean values as loaded from the API, kept alongside the
  // select-friendly strings so an explicit `true`/`false` is preserved
  // verbatim on save when the user does not touch that control. Both
  // controls are two-option (show/hide), but the API persists
  // `boolean | null`; without these refs, saving an unrelated preference
  // would collapse an API-set explicit default-side value back to `null`.
  const [loadedTfSeconds, setLoadedTfSeconds] = useState<boolean | null>(null);
  const [loadedTfTzLabel, setLoadedTfTzLabel] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    // Build timezone list
    try {
      setTimezones(Intl.supportedValuesOf("timeZone"));
    } catch {
      setTimezones([browserTimezone]);
    }

    // Fetch current preferences
    fetch("/api/accounts/me/preferences")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.data) return;
        const d = data.data;
        setLocale(d.locale ?? "");
        setTimezone(d.timezone ?? "");
        setTfLocale(
          d.timeFormatLocale == null ? TF_LOCALE_BROWSER : d.timeFormatLocale,
        );
        setTfHourCycle(d.timeFormatHourCycle ?? "auto");
        setTfSeconds(d.timeFormatSeconds === false ? "hide" : "show");
        setTfTzLabel(d.timeFormatTzLabel === true ? "show" : "hide");
        setLoadedTfSeconds(d.timeFormatSeconds ?? null);
        setLoadedTfTzLabel(d.timeFormatTzLabel ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [browserTimezone]);

  // Map the select states to the nullable stored-preference shape. `null`
  // uniformly resets a field to the app default.
  //
  // For the two boolean controls, an untouched control re-emits the value
  // exactly as loaded from the API: if the displayed show/hide state still
  // matches what the loaded value resolves to, the loaded value (which may
  // be an explicit `true`/`false` set via the API, or `null`) is sent back
  // verbatim rather than collapsed to `null`. Only when the user actually
  // flips a control does it map to the canonical value — the default side
  // to `null` (so "never touched" stays indistinguishable from the app
  // default), the non-default side to the explicit boolean.
  function buildTimeFormat(): StoredTimeFormat {
    const secondsShownNow = tfSeconds !== "hide";
    const secondsShownLoaded = loadedTfSeconds ?? true;
    const timeFormatSeconds =
      secondsShownNow === secondsShownLoaded
        ? loadedTfSeconds
        : secondsShownNow
          ? null
          : false;

    const tzShownNow = tfTzLabel === "show";
    const tzShownLoaded = loadedTfTzLabel ?? false;
    const timeFormatTzLabel =
      tzShownNow === tzShownLoaded ? loadedTfTzLabel : tzShownNow ? true : null;

    return {
      timeFormatLocale: tfLocale === TF_LOCALE_BROWSER ? null : tfLocale,
      timeFormatHourCycle:
        tfHourCycle === "h12" || tfHourCycle === "h23" ? tfHourCycle : null,
      timeFormatSeconds,
      timeFormatTzLabel,
    };
  }

  // Live preview: resolve the pending selections (the `'app'` sentinel
  // resolves against the *pending* language selection, not the committed
  // route locale) and format the sample instant with the general
  // formatter, which observes all four options.
  const previewStored = buildTimeFormat();
  const pendingAppLocale = locale || committedLocale;
  const previewResolved = resolveTimeFormat(previewStored, pendingAppLocale);
  const previewTimezone = timezone || browserTimezone;
  const previewText = formatDateTime(
    PREVIEW_INSTANT,
    previewTimezone,
    previewResolved,
  );

  async function handleSave() {
    setSaving(true);
    setMessage("");

    try {
      const csrfToken = readCsrfToken();
      const res = await fetch("/api/accounts/me/preferences", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify({
          locale: locale || null,
          timezone: timezone || null,
          ...buildTimeFormat(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage(body?.error ?? "Failed to save preferences");
        return;
      }

      setMessage(t("saved"));
      // Re-run the client provider's fetch so already-mounted <Timestamp>s
      // pick up the new format immediately — router.refresh() only
      // re-renders server components, not the client provider's effect.
      refreshPreferences();
      router.refresh();
    } catch {
      setMessage("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return null;
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">{t("heading")}</h1>

      <div className="space-y-6">
        {/* Locale selector */}
        <div className="space-y-2">
          <Label htmlFor="locale">{t("locale")}</Label>
          <Select value={locale} onValueChange={setLocale}>
            <SelectTrigger id="locale">
              <SelectValue placeholder={t("browserDefault")} />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(LOCALE_LABELS).map(([code, label]) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Timezone selector */}
        <div className="space-y-2">
          <Label htmlFor="timezone">{t("timezone")}</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="timezone">
              <SelectValue placeholder={t("timezonePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {timezones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                  {tz === browserTimezone ? ` (${t("browserDefault")})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!timezone && (
            <p className="text-muted-foreground text-sm">
              {t("browserDefault")}: {browserTimezone}
            </p>
          )}
        </div>

        {/* Time-format options (#766) */}
        <div
          className="space-y-4 border-t pt-6"
          data-slot="time-format-section"
        >
          <div className="space-y-1">
            <h2 className="text-lg font-medium">{t("timeFormat")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("timeFormatDescription")}
            </p>
          </div>

          {/* Live preview */}
          <div className="space-y-1">
            <Label>{t("timeFormatPreview")}</Label>
            <p
              className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm tabular-nums"
              data-slot="time-format-preview"
            >
              {previewText}
            </p>
          </div>

          {/* Formatting locale */}
          <div className="space-y-2">
            <Label htmlFor="tf-locale">{t("timeFormatLocale")}</Label>
            <Select value={tfLocale} onValueChange={setTfLocale}>
              <SelectTrigger id="tf-locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TF_LOCALE_BROWSER}>
                  {t("timeFormatLocaleBrowser")}
                </SelectItem>
                <SelectItem value={TIME_FORMAT_LOCALE_APP}>
                  {t("timeFormatLocaleApp")}
                </SelectItem>
                {CURATED_TIME_FORMAT_LOCALES.map((tag) => (
                  <SelectItem key={tag} value={tag}>
                    {tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hour cycle */}
          <div className="space-y-2">
            <Label htmlFor="tf-hour-cycle">{t("timeFormatHourCycle")}</Label>
            <Select value={tfHourCycle} onValueChange={setTfHourCycle}>
              <SelectTrigger id="tf-hour-cycle">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t("timeFormatHourCycleAuto")}
                </SelectItem>
                <SelectItem value="h12">
                  {t("timeFormatHourCycle12")}
                </SelectItem>
                <SelectItem value="h23">
                  {t("timeFormatHourCycle24")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Seconds */}
          <div className="space-y-2">
            <Label htmlFor="tf-seconds">{t("timeFormatSeconds")}</Label>
            <Select value={tfSeconds} onValueChange={setTfSeconds}>
              <SelectTrigger id="tf-seconds">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="show">
                  {t("timeFormatSecondsShow")}
                </SelectItem>
                <SelectItem value="hide">
                  {t("timeFormatSecondsHide")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Timezone label */}
          <div className="space-y-2">
            <Label htmlFor="tf-tz-label">{t("timeFormatTzLabel")}</Label>
            <Select value={tfTzLabel} onValueChange={setTfTzLabel}>
              <SelectTrigger id="tf-tz-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="show">
                  {t("timeFormatTzLabelShow")}
                </SelectItem>
                <SelectItem value="hide">
                  {t("timeFormatTzLabelHide")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-muted-foreground text-xs">
            {t("timeFormatCompactNote")}
          </p>
        </div>

        {/* Save */}
        <div className="flex items-center gap-4">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
          {message && (
            <p className="text-sm text-muted-foreground">{message}</p>
          )}
        </div>
      </div>
    </>
  );
}
