"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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

// ── Constants ───────────────────────────────────────────────────

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  ko: "한국어",
};

// ── Component ───────────────────────────────────────────────────

export function PreferencesForm() {
  const t = useTranslations("profile");
  const router = useRouter();

  const [locale, setLocale] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");
  const [timezones, setTimezones] = useState<string[]>([]);
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
        if (data?.data) {
          setLocale(data.data.locale ?? "");
          setTimezone(data.data.timezone ?? "");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [browserTimezone]);

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
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage(body?.error ?? "Failed to save preferences");
        return;
      }

      setMessage(t("saved"));
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
    <div className="mx-auto max-w-lg space-y-8">
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
    </div>
  );
}
