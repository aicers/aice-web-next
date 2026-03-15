"use client";

import { AlertCircle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ── Types ───────────────────────────────────────────────────────

interface SystemSettingRow {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

interface SystemSettingsPanelProps {
  readOnly: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────

function toRecord(
  rows: SystemSettingRow[],
): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

// ── Component ───────────────────────────────────────────────────

export function SystemSettingsPanel({ readOnly }: SystemSettingsPanelProps) {
  const t = useTranslations("systemSettings");
  const tc = useTranslations("common");

  const [settings, setSettings] = useState<Record<
    string,
    Record<string, unknown>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/system-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data) setSettings(toRecord(data.data));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function saveSetting(key: string, value: Record<string, unknown>) {
    setSaving(key);
    setMessage(null);

    try {
      const csrfToken = readCsrfToken();
      const res = await fetch(`/api/system-settings/${key}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify({ value }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const details = body?.details?.join(", ") ?? body?.error ?? t("error");
        setMessage({ type: "error", text: details });
        return;
      }

      const data = await res.json();
      setSettings((prev) =>
        prev ? { ...prev, [key]: data.data.value } : prev,
      );
      setMessage({ type: "success", text: t("saved") });
    } catch {
      setMessage({ type: "error", text: t("error") });
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tc("loading")}
      </div>
    );
  }

  if (!settings) {
    return (
      <p className="py-8 text-sm text-destructive">
        <AlertCircle className="mr-1 inline size-4" />
        {t("error")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {readOnly && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <Info className="size-4 shrink-0" />
          {t("readOnlyNotice")}
        </div>
      )}

      {message && (
        <div
          className={`flex items-center gap-2 rounded-md border px-4 py-3 text-sm ${
            message.type === "success"
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {message.type === "success" ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <AlertCircle className="size-4 shrink-0" />
          )}
          {message.text}
        </div>
      )}

      <Tabs defaultValue="password">
        <TabsList>
          <TabsTrigger value="password">{t("tabs.password")}</TabsTrigger>
          <TabsTrigger value="session">{t("tabs.session")}</TabsTrigger>
          <TabsTrigger value="lockout">{t("tabs.lockout")}</TabsTrigger>
          <TabsTrigger value="jwt">{t("tabs.jwt")}</TabsTrigger>
          <TabsTrigger value="mfa">{t("tabs.mfa")}</TabsTrigger>
          <TabsTrigger value="rateLimits">{t("tabs.rateLimits")}</TabsTrigger>
        </TabsList>

        <TabsContent value="password">
          <PasswordPolicyForm
            value={settings.password_policy}
            readOnly={readOnly}
            saving={saving === "password_policy"}
            onSave={(v) => saveSetting("password_policy", v)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="session">
          <SessionPolicyForm
            value={settings.session_policy}
            readOnly={readOnly}
            saving={saving === "session_policy"}
            onSave={(v) => saveSetting("session_policy", v)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="lockout">
          <LockoutPolicyForm
            value={settings.lockout_policy}
            readOnly={readOnly}
            saving={saving === "lockout_policy"}
            onSave={(v) => saveSetting("lockout_policy", v)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="jwt">
          <JwtPolicyForm
            value={settings.jwt_policy}
            readOnly={readOnly}
            saving={saving === "jwt_policy"}
            onSave={(v) => saveSetting("jwt_policy", v)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="mfa">
          <MfaPolicyForm
            value={settings.mfa_policy}
            readOnly={readOnly}
            saving={saving === "mfa_policy"}
            onSave={(v) => saveSetting("mfa_policy", v)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="rateLimits">
          <RateLimitsForm
            signinValue={settings.signin_rate_limit}
            apiValue={settings.api_rate_limit}
            readOnly={readOnly}
            saving={
              saving === "signin_rate_limit" || saving === "api_rate_limit"
            }
            onSaveSignIn={(v) => saveSetting("signin_rate_limit", v)}
            onSaveApi={(v) => saveSetting("api_rate_limit", v)}
            t={t}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Shared field components ─────────────────────────────────────

function NumberField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  value: number | string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        <span className="ml-0.5 text-destructive">*</span>
      </Label>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="max-w-xs"
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

// ── Policy forms ────────────────────────────────────────────────

interface PolicyFormProps {
  value: Record<string, unknown>;
  readOnly: boolean;
  saving: boolean;
  onSave: (value: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations<"systemSettings">>;
}

function PasswordPolicyForm({
  value,
  readOnly,
  saving,
  onSave,
  t,
}: PolicyFormProps) {
  const [minLength, setMinLength] = useState(String(value.min_length ?? 12));
  const [maxLength, setMaxLength] = useState(String(value.max_length ?? 128));
  const [complexityEnabled, setComplexityEnabled] = useState(
    Boolean(value.complexity_enabled),
  );
  const [reuseBanCount, setReuseBanCount] = useState(
    String(value.reuse_ban_count ?? 5),
  );

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("passwordPolicy.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("passwordPolicy.description")}
        </p>
      </div>

      <NumberField
        id="min_length"
        label={t("passwordPolicy.minLength")}
        description={t("passwordPolicy.minLengthDescription")}
        value={minLength}
        onChange={setMinLength}
        disabled={readOnly}
      />
      <NumberField
        id="max_length"
        label={t("passwordPolicy.maxLength")}
        description={t("passwordPolicy.maxLengthDescription")}
        value={maxLength}
        onChange={setMaxLength}
        disabled={readOnly}
      />
      <div className="flex items-center gap-3">
        <Switch
          id="complexity_enabled"
          checked={complexityEnabled}
          onCheckedChange={setComplexityEnabled}
          disabled={readOnly}
        />
        <div>
          <Label htmlFor="complexity_enabled">
            {t("passwordPolicy.complexityEnabled")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("passwordPolicy.complexityEnabledDescription")}
          </p>
        </div>
      </div>
      <NumberField
        id="reuse_ban_count"
        label={t("passwordPolicy.reuseBanCount")}
        description={t("passwordPolicy.reuseBanCountDescription")}
        value={reuseBanCount}
        onChange={setReuseBanCount}
        disabled={readOnly}
      />

      {!readOnly && (
        <Button
          onClick={() =>
            onSave({
              min_length: Number(minLength),
              max_length: Number(maxLength),
              complexity_enabled: complexityEnabled,
              reuse_ban_count: Number(reuseBanCount),
            })
          }
          disabled={saving}
        >
          {saving ? t("saving") : t("tabs.password")}
        </Button>
      )}
    </div>
  );
}

function SessionPolicyForm({
  value,
  readOnly,
  saving,
  onSave,
  t,
}: PolicyFormProps) {
  const [idleTimeout, setIdleTimeout] = useState(
    String(value.idle_timeout_minutes ?? 30),
  );
  const [absoluteTimeout, setAbsoluteTimeout] = useState(
    String(value.absolute_timeout_hours ?? 8),
  );
  const [maxSessions, setMaxSessions] = useState(
    value.max_sessions != null ? String(value.max_sessions) : "",
  );

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("sessionPolicy.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("sessionPolicy.description")}
        </p>
      </div>

      <NumberField
        id="idle_timeout_minutes"
        label={t("sessionPolicy.idleTimeoutMinutes")}
        description={t("sessionPolicy.idleTimeoutMinutesDescription")}
        value={idleTimeout}
        onChange={setIdleTimeout}
        disabled={readOnly}
      />
      <NumberField
        id="absolute_timeout_hours"
        label={t("sessionPolicy.absoluteTimeoutHours")}
        description={t("sessionPolicy.absoluteTimeoutHoursDescription")}
        value={absoluteTimeout}
        onChange={setAbsoluteTimeout}
        disabled={readOnly}
      />
      <div className="space-y-2">
        <Label htmlFor="max_sessions">{t("sessionPolicy.maxSessions")}</Label>
        <Input
          id="max_sessions"
          type="number"
          value={maxSessions}
          onChange={(e) => setMaxSessions(e.target.value)}
          disabled={readOnly}
          placeholder="∞"
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground">
          {t("sessionPolicy.maxSessionsDescription")}
        </p>
      </div>

      {!readOnly && (
        <Button
          onClick={() =>
            onSave({
              idle_timeout_minutes: Number(idleTimeout),
              absolute_timeout_hours: Number(absoluteTimeout),
              max_sessions: maxSessions ? Number(maxSessions) : null,
            })
          }
          disabled={saving}
        >
          {saving ? t("saving") : t("tabs.session")}
        </Button>
      )}
    </div>
  );
}

function LockoutPolicyForm({
  value,
  readOnly,
  saving,
  onSave,
  t,
}: PolicyFormProps) {
  const [threshold, setThreshold] = useState(
    String(value.stage1_threshold ?? 5),
  );
  const [duration, setDuration] = useState(
    String(value.stage1_duration_minutes ?? 30),
  );

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("lockoutPolicy.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("lockoutPolicy.description")}
        </p>
      </div>

      <NumberField
        id="stage1_threshold"
        label={t("lockoutPolicy.stage1Threshold")}
        description={t("lockoutPolicy.stage1ThresholdDescription")}
        value={threshold}
        onChange={setThreshold}
        disabled={readOnly}
      />
      <NumberField
        id="stage1_duration_minutes"
        label={t("lockoutPolicy.stage1DurationMinutes")}
        description={t("lockoutPolicy.stage1DurationMinutesDescription")}
        value={duration}
        onChange={setDuration}
        disabled={readOnly}
      />

      {!readOnly && (
        <Button
          onClick={() =>
            onSave({
              stage1_threshold: Number(threshold),
              stage1_duration_minutes: Number(duration),
            })
          }
          disabled={saving}
        >
          {saving ? t("saving") : t("tabs.lockout")}
        </Button>
      )}
    </div>
  );
}

function JwtPolicyForm({
  value,
  readOnly,
  saving,
  onSave,
  t,
}: PolicyFormProps) {
  const [expiration, setExpiration] = useState(
    String(value.access_token_expiration_minutes ?? 15),
  );

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("jwtPolicy.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("jwtPolicy.description")}
        </p>
      </div>

      <NumberField
        id="access_token_expiration_minutes"
        label={t("jwtPolicy.accessTokenExpirationMinutes")}
        description={t("jwtPolicy.accessTokenExpirationMinutesDescription")}
        value={expiration}
        onChange={setExpiration}
        disabled={readOnly}
      />

      {!readOnly && (
        <Button
          onClick={() =>
            onSave({
              access_token_expiration_minutes: Number(expiration),
            })
          }
          disabled={saving}
        >
          {saving ? t("saving") : t("tabs.jwt")}
        </Button>
      )}
    </div>
  );
}

function MfaPolicyForm({
  value,
  readOnly,
  saving,
  onSave,
  t,
}: PolicyFormProps) {
  const methods = (value.allowed_methods as string[]) ?? ["webauthn", "totp"];
  const [webauthn, setWebauthn] = useState(methods.includes("webauthn"));
  const [totp, setTotp] = useState(methods.includes("totp"));

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("mfaPolicy.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("mfaPolicy.description")}
        </p>
      </div>

      <div className="space-y-3">
        <Label>{t("mfaPolicy.allowedMethods")}</Label>
        <div className="flex items-center gap-2">
          <Checkbox
            id="mfa_webauthn"
            checked={webauthn}
            onCheckedChange={(c) => setWebauthn(c === true)}
            disabled={readOnly}
          />
          <Label htmlFor="mfa_webauthn" className="font-normal">
            {t("mfaPolicy.webauthn")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="mfa_totp"
            checked={totp}
            onCheckedChange={(c) => setTotp(c === true)}
            disabled={readOnly}
          />
          <Label htmlFor="mfa_totp" className="font-normal">
            {t("mfaPolicy.totp")}
          </Label>
        </div>
      </div>

      {!readOnly && (
        <Button
          onClick={() => {
            const allowed: string[] = [];
            if (webauthn) allowed.push("webauthn");
            if (totp) allowed.push("totp");
            onSave({ allowed_methods: allowed });
          }}
          disabled={saving || (!webauthn && !totp)}
        >
          {saving ? t("saving") : t("tabs.mfa")}
        </Button>
      )}
    </div>
  );
}

interface RateLimitsFormProps {
  signinValue: Record<string, unknown>;
  apiValue: Record<string, unknown>;
  readOnly: boolean;
  saving: boolean;
  onSaveSignIn: (value: Record<string, unknown>) => void;
  onSaveApi: (value: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations<"systemSettings">>;
}

function RateLimitsForm({
  signinValue,
  apiValue,
  readOnly,
  saving,
  onSaveSignIn,
  onSaveApi,
  t,
}: RateLimitsFormProps) {
  const [perIpCount, setPerIpCount] = useState(
    String(signinValue.per_ip_count ?? 20),
  );
  const [perIpWindow, setPerIpWindow] = useState(
    String(signinValue.per_ip_window_minutes ?? 5),
  );
  const [perAccountIpCount, setPerAccountIpCount] = useState(
    String(signinValue.per_account_ip_count ?? 5),
  );
  const [perAccountIpWindow, setPerAccountIpWindow] = useState(
    String(signinValue.per_account_ip_window_minutes ?? 5),
  );
  const [globalCount, setGlobalCount] = useState(
    String(signinValue.global_count ?? 100),
  );
  const [globalWindow, setGlobalWindow] = useState(
    String(signinValue.global_window_minutes ?? 1),
  );

  const [perUserCount, setPerUserCount] = useState(
    String(apiValue.per_user_count ?? 100),
  );
  const [perUserWindow, setPerUserWindow] = useState(
    String(apiValue.per_user_window_minutes ?? 1),
  );

  return (
    <div className="space-y-8 pt-4">
      <div>
        <h2 className="text-lg font-medium">{t("rateLimits.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("rateLimits.description")}
        </p>
      </div>

      {/* Sign-in rate limits */}
      <div className="space-y-6">
        <h3 className="font-medium">{t("rateLimits.signInTitle")}</h3>

        <NumberField
          id="per_ip_count"
          label={t("rateLimits.perIpCount")}
          description={t("rateLimits.perIpCountDescription")}
          value={perIpCount}
          onChange={setPerIpCount}
          disabled={readOnly}
        />
        <NumberField
          id="per_ip_window_minutes"
          label={t("rateLimits.perIpWindowMinutes")}
          description={t("rateLimits.perIpWindowMinutesDescription")}
          value={perIpWindow}
          onChange={setPerIpWindow}
          disabled={readOnly}
        />
        <NumberField
          id="per_account_ip_count"
          label={t("rateLimits.perAccountIpCount")}
          description={t("rateLimits.perAccountIpCountDescription")}
          value={perAccountIpCount}
          onChange={setPerAccountIpCount}
          disabled={readOnly}
        />
        <NumberField
          id="per_account_ip_window_minutes"
          label={t("rateLimits.perAccountIpWindowMinutes")}
          description={t("rateLimits.perAccountIpWindowMinutesDescription")}
          value={perAccountIpWindow}
          onChange={setPerAccountIpWindow}
          disabled={readOnly}
        />
        <NumberField
          id="global_count"
          label={t("rateLimits.globalCount")}
          description={t("rateLimits.globalCountDescription")}
          value={globalCount}
          onChange={setGlobalCount}
          disabled={readOnly}
        />
        <NumberField
          id="global_window_minutes"
          label={t("rateLimits.globalWindowMinutes")}
          description={t("rateLimits.globalWindowMinutesDescription")}
          value={globalWindow}
          onChange={setGlobalWindow}
          disabled={readOnly}
        />

        {!readOnly && (
          <Button
            onClick={() =>
              onSaveSignIn({
                per_ip_count: Number(perIpCount),
                per_ip_window_minutes: Number(perIpWindow),
                per_account_ip_count: Number(perAccountIpCount),
                per_account_ip_window_minutes: Number(perAccountIpWindow),
                global_count: Number(globalCount),
                global_window_minutes: Number(globalWindow),
              })
            }
            disabled={saving}
          >
            {saving ? t("saving") : t("rateLimits.signInTitle")}
          </Button>
        )}
      </div>

      {/* API rate limits */}
      <div className="space-y-6">
        <h3 className="font-medium">{t("rateLimits.apiTitle")}</h3>

        <NumberField
          id="per_user_count"
          label={t("rateLimits.perUserCount")}
          description={t("rateLimits.perUserCountDescription")}
          value={perUserCount}
          onChange={setPerUserCount}
          disabled={readOnly}
        />
        <NumberField
          id="per_user_window_minutes"
          label={t("rateLimits.perUserWindowMinutes")}
          description={t("rateLimits.perUserWindowMinutesDescription")}
          value={perUserWindow}
          onChange={setPerUserWindow}
          disabled={readOnly}
        />

        {!readOnly && (
          <Button
            onClick={() =>
              onSaveApi({
                per_user_count: Number(perUserCount),
                per_user_window_minutes: Number(perUserWindow),
              })
            }
            disabled={saving}
          >
            {saving ? t("saving") : t("rateLimits.apiTitle")}
          </Button>
        )}
      </div>
    </div>
  );
}
