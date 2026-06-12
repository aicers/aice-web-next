"use client";

import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { AimerPhase2Block } from "@/components/settings/aimer-phase2-block";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { panelSurface } from "@/components/ui/panel-surface";
import { Link } from "@/i18n/navigation";
import type {
  AimerIntegrationMissingReason,
  AimerIntegrationSetup,
} from "@/lib/aimer/setup-status";
import type {
  AimerSigningKeyPublicEntry,
  AimerSigningKeyStatus,
} from "@/lib/aimer/signing-key";
import { cn } from "@/lib/utils";

// ── Helpers ─────────────────────────────────────────────────────

const ROTATION_BANNER_YELLOW_DAYS = 30;
const ROTATION_BANNER_RED_DAYS = 7;

function daysUntil(iso: string): number {
  const due = Date.parse(iso);
  if (!Number.isFinite(due)) return Number.POSITIVE_INFINITY;
  return Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000));
}

function rotationBannerLevel(
  active: AimerSigningKeyPublicEntry | null,
): "none" | "yellow" | "red" | "overdue" {
  if (!active) return "none";
  // Compare the parsed timestamp directly with `Date.now()` first, so a
  // key whose `recommendedRotationAt` is even one minute in the past is
  // immediately classified as overdue.  Falling through to the
  // day-bucket arithmetic would round up to `0` and mis-show red.
  const due = Date.parse(active.recommendedRotationAt);
  if (Number.isFinite(due) && due <= Date.now()) return "overdue";
  const days = daysUntil(active.recommendedRotationAt);
  if (days <= ROTATION_BANNER_RED_DAYS) return "red";
  if (days <= ROTATION_BANNER_YELLOW_DAYS) return "yellow";
  return "none";
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

// ── Component ───────────────────────────────────────────────────

interface AimerIntegrationPanelProps {
  initialSetup: AimerIntegrationSetup;
  initialKeyStatus: AimerSigningKeyStatus;
  customerStats: { total: number; configured: number };
  /**
   * Active customer list used by the Phase 2 status block (#620) for
   * the per-customer status fetcher / pause toggle / sync-now /
   * backfill form. The page passes this in already filtered to
   * `status = 'active'` and gated on `isSystemAdministrator`.
   */
  customers: { id: number; name: string }[];
}

export function AimerIntegrationPanel({
  initialSetup,
  initialKeyStatus,
  customerStats,
  customers,
}: AimerIntegrationPanelProps) {
  const t = useTranslations("aimerIntegration");
  const tc = useTranslations("common");

  const [setup, setSetup] = useState(initialSetup);
  const [keyStatus, setKeyStatus] = useState(initialKeyStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const setupStatus = deriveSetupStatusUI(setup, keyStatus);

  async function postKeyAction(
    action: "generate" | "rotate" | "switch" | "deactivate",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    setBusy(action);
    setMessage(null);
    try {
      const csrfToken = readCsrfToken();
      const res = await fetch("/api/aimer-integration/keypair/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify({ action, ...extra }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage({
          type: "error",
          text: body?.error ?? t("errors.actionFailed"),
        });
        return;
      }
      const body = await res.json();
      setKeyStatus(body.data as AimerSigningKeyStatus);
      setSetup((prev) => ({
        ...prev,
        hasActiveSigningKey: !!(body.data as AimerSigningKeyStatus).active,
      }));
      setMessage({ type: "success", text: t(`success.${action}`) });
    } catch {
      setMessage({ type: "error", text: t("errors.actionFailed") });
    } finally {
      setBusy(null);
    }
  }

  async function saveSetting(
    key:
      | "aice_id"
      | "clumit_insight_bridge_url"
      | "clumit_insight_default_model_name"
      | "clumit_insight_default_model",
    value: string,
  ): Promise<string | null> {
    setBusy(key);
    setMessage(null);
    try {
      const csrfToken = readCsrfToken();
      const res = await fetch(`/api/aimer-integration/settings/${key}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage({
          type: "error",
          text: body?.error ?? t("errors.actionFailed"),
        });
        return null;
      }
      const body = (await res.json()) as {
        data: { key: string; value: string };
      };
      setSetup((prev) => {
        switch (key) {
          case "aice_id":
            return { ...prev, aiceId: body.data.value };
          case "clumit_insight_bridge_url":
            return { ...prev, bridgeUrl: body.data.value };
          case "clumit_insight_default_model_name":
            return { ...prev, defaultModelName: body.data.value };
          case "clumit_insight_default_model":
            return { ...prev, defaultModel: body.data.value };
        }
      });
      setMessage({ type: "success", text: t("success.settingSaved") });
      return body.data.value;
    } catch {
      setMessage({ type: "error", text: t("errors.actionFailed") });
      return null;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {keyStatus.filePermissionAlert && (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          <div>
            <p className="font-medium">{t("permissionAlert.title")}</p>
            <p className="mt-1">
              {t("permissionAlert.body", {
                path: "data/keys/aimer-context-signing.json",
                observed: keyStatus.observedFilePermission ?? "?",
              })}
            </p>
          </div>
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

      <SetupStatusBlock status={setupStatus} t={t} />

      <SigningKeyBlock
        keyStatus={keyStatus}
        busy={busy}
        onAction={postKeyAction}
        t={t}
        tc={tc}
      />

      <SettingsBlock
        aiceId={setup.aiceId}
        bridgeUrl={setup.bridgeUrl}
        defaultModelName={setup.defaultModelName}
        defaultModel={setup.defaultModel}
        busyKey={busy}
        onSave={saveSetting}
        t={t}
      />

      <CustomerExternalKeyBlock
        total={customerStats.total}
        configured={customerStats.configured}
        t={t}
      />

      <AimerPhase2Block customers={customers} />
    </div>
  );
}

// ── Setup status block ──────────────────────────────────────────

interface SetupStatusUI {
  configured: boolean;
  missing: AimerIntegrationMissingReason[];
}

function deriveSetupStatusUI(
  setup: AimerIntegrationSetup,
  keyStatus: AimerSigningKeyStatus,
): SetupStatusUI {
  const missing: AimerIntegrationMissingReason[] = [];
  if (!setup.aiceId) missing.push("aiceId");
  if (!setup.bridgeUrl) missing.push("bridgeUrl");
  if (!setup.defaultModelName) missing.push("defaultModelName");
  if (!setup.defaultModel) missing.push("defaultModel");
  // Live status preferred over the snapshot so the badge transitions
  // synchronously after Generate/Switch without a refetch.
  if (!keyStatus.active) missing.push("signingKey");
  return { configured: missing.length === 0, missing };
}

function SetupStatusBlock({
  status,
  t,
}: {
  status: SetupStatusUI;
  t: ReturnType<typeof useTranslations<"aimerIntegration">>;
}) {
  return (
    <section className={cn(panelSurface, "p-5")}>
      <h2 className="text-lg font-medium">{t("setupStatus.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("setupStatus.description")}
      </p>
      <div className="mt-4 flex items-center gap-2">
        {status.configured ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800 dark:bg-green-950 dark:text-green-200"
            data-testid="aimer-setup-configured"
          >
            <CheckCircle2 className="size-4" />
            {t("setupStatus.configured")}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-sm font-medium text-destructive"
            data-testid="aimer-setup-not-configured"
          >
            <AlertCircle className="size-4" />
            {t("setupStatus.notConfigured")}
          </span>
        )}
      </div>
      {!status.configured && (
        <ul className="mt-3 list-disc pl-6 text-sm text-muted-foreground">
          {status.missing.map((reason) => (
            <li key={reason}>{t(`setupStatus.missing.${reason}`)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Signing key block ───────────────────────────────────────────

function SigningKeyBlock({
  keyStatus,
  busy,
  onAction,
  t,
  tc,
}: {
  keyStatus: AimerSigningKeyStatus;
  busy: string | null;
  onAction: (
    action: "generate" | "rotate" | "switch" | "deactivate",
    extra?: Record<string, unknown>,
  ) => Promise<void>;
  t: ReturnType<typeof useTranslations<"aimerIntegration">>;
  tc: ReturnType<typeof useTranslations<"common">>;
}) {
  const { state, active, pending, previous } = keyStatus;
  const [switchConfirmed, setSwitchConfirmed] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    null | "rotate" | "switch" | "deactivate"
  >(null);

  const banner = rotationBannerLevel(active);

  return (
    <section className={cn(panelSurface, "p-5")}>
      <h2 className="text-lg font-medium">{t("signingKey.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("signingKey.description")}
      </p>

      {banner !== "none" && active && (
        <div
          className={`mt-4 flex items-start gap-2 rounded-md border px-4 py-3 text-sm ${
            banner === "red"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : banner === "yellow"
                ? "border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
                : "border-muted bg-muted text-muted-foreground"
          }`}
        >
          <TriangleAlert className="size-4 shrink-0" />
          <div>
            <p className="font-medium">
              {banner === "overdue"
                ? t("signingKey.rotation.overdueTitle")
                : banner === "red"
                  ? t("signingKey.rotation.redTitle")
                  : t("signingKey.rotation.yellowTitle")}
            </p>
            <p className="mt-1">
              {t("signingKey.rotation.body", {
                date: active.recommendedRotationAt,
              })}
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-6">
        {state === "empty" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("signingKey.emptyDescription")}
            </p>
            <Button
              data-testid="aimer-key-generate"
              disabled={busy === "generate"}
              onClick={() => onAction("generate")}
            >
              {busy === "generate"
                ? tc("loading")
                : t("signingKey.actions.generate")}
            </Button>
          </div>
        )}

        {active && (
          <KeyEntryCard
            entry={active}
            label={t("signingKey.slots.active")}
            t={t}
          />
        )}

        {pending && (
          <KeyEntryCard
            entry={pending}
            label={t("signingKey.slots.pending")}
            t={t}
          />
        )}

        {previous && (
          <KeyEntryCard
            entry={previous}
            label={t("signingKey.slots.previous")}
            t={t}
          />
        )}

        {state === "active_only" && (
          <div className="flex flex-wrap gap-3">
            <Button
              data-testid="aimer-key-rotate"
              disabled={busy === "rotate"}
              variant="secondary"
              onClick={() => setConfirmAction("rotate")}
            >
              {busy === "rotate"
                ? tc("loading")
                : t("signingKey.actions.rotate")}
            </Button>
          </div>
        )}

        {state === "active_and_pending" && pending && (
          <div className={cn("space-y-3", panelSurface, "p-4")}>
            <p className="text-sm font-medium">
              {t("signingKey.switch.guidanceTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("signingKey.switch.guidanceBody")}
            </p>
            <div className="flex items-start gap-2">
              <Checkbox
                id="aimer-switch-confirm"
                checked={switchConfirmed}
                onCheckedChange={(c) => setSwitchConfirmed(c === true)}
              />
              <Label
                htmlFor="aimer-switch-confirm"
                className="text-sm font-normal"
              >
                {t("signingKey.switch.confirmCheckbox")}
              </Label>
            </div>
            <Button
              data-testid="aimer-key-switch"
              disabled={!switchConfirmed || busy === "switch"}
              onClick={() => setConfirmAction("switch")}
            >
              {busy === "switch"
                ? tc("loading")
                : t("signingKey.actions.switch")}
            </Button>
          </div>
        )}

        {state === "active_and_previous" && previous && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {previous.recommendedDeactivateAt
                ? t("signingKey.deactivate.windowEnds", {
                    date: previous.recommendedDeactivateAt,
                  })
                : null}
            </span>
            <Button
              data-testid="aimer-key-deactivate"
              variant="secondary"
              disabled={busy === "deactivate"}
              onClick={() => setConfirmAction("deactivate")}
            >
              {busy === "deactivate"
                ? tc("loading")
                : t("signingKey.actions.deactivate")}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction === "rotate"}
        title={t("signingKey.rotateConfirm.title")}
        description={t("signingKey.rotateConfirm.body")}
        confirmLabel={t("signingKey.actions.rotate")}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          setConfirmAction(null);
          await onAction("rotate");
        }}
      />

      <ConfirmDialog
        open={confirmAction === "switch"}
        title={t("signingKey.switchConfirm.title")}
        description={t("signingKey.switchConfirm.body")}
        confirmLabel={t("signingKey.actions.switch")}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          setConfirmAction(null);
          setSwitchConfirmed(false);
          await onAction("switch", { confirmRegistered: true });
        }}
      />

      <ConfirmDialog
        open={confirmAction === "deactivate"}
        title={t("signingKey.deactivateConfirm.title")}
        description={t("signingKey.deactivateConfirm.body")}
        confirmLabel={t("signingKey.actions.deactivate")}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          setConfirmAction(null);
          await onAction("deactivate");
        }}
      />
    </section>
  );
}

function KeyEntryCard({
  entry,
  label,
  t,
}: {
  entry: AimerSigningKeyPublicEntry;
  label: string;
  t: ReturnType<typeof useTranslations<"aimerIntegration">>;
}) {
  return (
    <div className={cn("space-y-3", panelSurface, "p-4")}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          kid: {entry.kid}
        </span>
      </div>

      <CopyableField
        label={t("signingKey.fields.thumbprintBase64Url")}
        helper={t("signingKey.fields.thumbprintBase64UrlHelper")}
        value={entry.thumbprintBase64Url}
        testId="aimer-thumbprint-b64"
      />
      <CopyableField
        label={t("signingKey.fields.thumbprintHexColons")}
        helper={t("signingKey.fields.thumbprintHexColonsHelper")}
        value={entry.thumbprintHexColons}
        testId="aimer-thumbprint-hex"
      />
      <CopyableField
        label={t("signingKey.fields.publicJwk")}
        helper={t("signingKey.fields.publicJwkHelper")}
        value={JSON.stringify(entry.publicJwk, null, 2)}
        multiline
        testId="aimer-public-jwk"
      />
    </div>
  );
}

function CopyableField({
  label,
  helper,
  value,
  multiline,
  testId,
}: {
  label: string;
  helper?: string;
  value: string;
  multiline?: boolean;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={async () => {
            const ok = await copyToClipboard(value);
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }
          }}
        >
          <Copy className="size-3" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {multiline ? (
        <pre
          data-testid={testId}
          className="overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all"
        >
          {value}
        </pre>
      ) : (
        <code
          data-testid={testId}
          className="block overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono break-all"
        >
          {value}
        </code>
      )}
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  );
}

// ── Settings block ──────────────────────────────────────────────

function SettingsBlock({
  aiceId,
  bridgeUrl,
  defaultModelName,
  defaultModel,
  busyKey,
  onSave,
  t,
}: {
  aiceId: string | null;
  bridgeUrl: string | null;
  defaultModelName: string | null;
  defaultModel: string | null;
  busyKey: string | null;
  onSave: (
    key:
      | "aice_id"
      | "clumit_insight_bridge_url"
      | "clumit_insight_default_model_name"
      | "clumit_insight_default_model",
    value: string,
  ) => Promise<string | null>;
  t: ReturnType<typeof useTranslations<"aimerIntegration">>;
}) {
  const [aiceIdDraft, setAiceIdDraft] = useState(aiceId ?? "");
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(bridgeUrl ?? "");
  const [modelNameDraft, setModelNameDraft] = useState(defaultModelName ?? "");
  const [modelDraft, setModelDraft] = useState(defaultModel ?? "");
  const [pendingSave, setPendingSave] = useState<
    | null
    | "aice_id"
    | "clumit_insight_bridge_url"
    | "clumit_insight_default_model_name"
    | "clumit_insight_default_model"
  >(null);

  const aiceDirty = aiceIdDraft.trim() !== (aiceId ?? "");
  const bridgeDirty = bridgeUrlDraft.trim() !== (bridgeUrl ?? "");
  const modelNameDirty = modelNameDraft.trim() !== (defaultModelName ?? "");
  const modelDirty = modelDraft.trim() !== (defaultModel ?? "");

  return (
    <section className={cn(panelSurface, "p-5")}>
      <h2 className="text-lg font-medium">{t("settings.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settings.description")}
      </p>

      <div className="mt-4 space-y-6">
        <div className="space-y-2">
          <Label htmlFor="aimer-aice-id">{t("settings.aiceIdLabel")}</Label>
          <Input
            id="aimer-aice-id"
            data-testid="aimer-aice-id"
            value={aiceIdDraft}
            onChange={(e) => setAiceIdDraft(e.target.value)}
            placeholder={t("settings.aiceIdPlaceholder")}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.aiceIdHelper")}
          </p>
          <Button
            type="button"
            data-testid="aimer-aice-id-save"
            disabled={!aiceDirty || busyKey === "aice_id"}
            onClick={() => setPendingSave("aice_id")}
          >
            {busyKey === "aice_id"
              ? t("settings.saving")
              : t("settings.saveAiceId")}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="aimer-bridge-url">
            {t("settings.bridgeUrlLabel")}
          </Label>
          <Input
            id="aimer-bridge-url"
            data-testid="aimer-bridge-url"
            value={bridgeUrlDraft}
            onChange={(e) => setBridgeUrlDraft(e.target.value)}
            placeholder={t("settings.bridgeUrlPlaceholder")}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.bridgeUrlHelper")}
          </p>
          <Button
            type="button"
            data-testid="aimer-bridge-url-save"
            disabled={!bridgeDirty || busyKey === "clumit_insight_bridge_url"}
            onClick={() => setPendingSave("clumit_insight_bridge_url")}
          >
            {busyKey === "clumit_insight_bridge_url"
              ? t("settings.saving")
              : t("settings.saveBridgeUrl")}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="aimer-default-model-name">
            {t("settings.defaultModelNameLabel")}
          </Label>
          <Input
            id="aimer-default-model-name"
            data-testid="aimer-default-model-name"
            value={modelNameDraft}
            onChange={(e) => setModelNameDraft(e.target.value)}
            placeholder={t("settings.defaultModelNamePlaceholder")}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.defaultModelNameHelper")}
          </p>
          <Button
            type="button"
            data-testid="aimer-default-model-name-save"
            disabled={
              !modelNameDirty || busyKey === "clumit_insight_default_model_name"
            }
            onClick={() => setPendingSave("clumit_insight_default_model_name")}
          >
            {busyKey === "clumit_insight_default_model_name"
              ? t("settings.saving")
              : t("settings.saveDefaultModelName")}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="aimer-default-model">
            {t("settings.defaultModelLabel")}
          </Label>
          <Input
            id="aimer-default-model"
            data-testid="aimer-default-model"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder={t("settings.defaultModelPlaceholder")}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.defaultModelHelper")}
          </p>
          <Button
            type="button"
            data-testid="aimer-default-model-save"
            disabled={!modelDirty || busyKey === "clumit_insight_default_model"}
            onClick={() => setPendingSave("clumit_insight_default_model")}
          >
            {busyKey === "clumit_insight_default_model"
              ? t("settings.saving")
              : t("settings.saveDefaultModel")}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingSave !== null}
        title={t("settings.effectWarning.title")}
        description={t("settings.effectWarning.body")}
        confirmLabel={t("settings.effectWarning.confirm")}
        onCancel={() => setPendingSave(null)}
        onConfirm={async () => {
          const key = pendingSave;
          setPendingSave(null);
          if (!key) return;
          const draft =
            key === "aice_id"
              ? aiceIdDraft
              : key === "clumit_insight_bridge_url"
                ? bridgeUrlDraft
                : key === "clumit_insight_default_model_name"
                  ? modelNameDraft
                  : modelDraft;
          const value = draft.trim();
          // Reset the local draft to the canonical (server-normalized)
          // value so non-canonical inputs (e.g. a bridge URL with a
          // trailing slash) are reflected in the UI.  Done in this
          // closure rather than a useEffect on the prop because the
          // canonical value can equal the prior prop value (round-trip
          // of an already-canonical input), which would not retrigger
          // a prop-watching effect.
          const canonical = await onSave(key, value);
          if (canonical !== null) {
            switch (key) {
              case "aice_id":
                setAiceIdDraft(canonical);
                break;
              case "clumit_insight_bridge_url":
                setBridgeUrlDraft(canonical);
                break;
              case "clumit_insight_default_model_name":
                setModelNameDraft(canonical);
                break;
              case "clumit_insight_default_model":
                setModelDraft(canonical);
                break;
            }
          }
        }}
      />
    </section>
  );
}

// ── Customer external_key info ──────────────────────────────────

function CustomerExternalKeyBlock({
  total,
  configured,
  t,
}: {
  total: number;
  configured: number;
  t: ReturnType<typeof useTranslations<"aimerIntegration">>;
}) {
  return (
    <section className={cn(panelSurface, "p-5")}>
      <div className="flex items-start gap-2">
        <Info className="size-4 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <p data-testid="aimer-customer-external-key-line">
            {t("customerExternalKey.line", { configured, total })}{" "}
            <Link href="/settings/customers" className="underline">
              {t("customerExternalKey.linkLabel")}
            </Link>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("customerExternalKey.note")}
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              try {
                await onConfirm();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
