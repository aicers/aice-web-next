"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { Bluetooth, Fingerprint, Nfc, Pencil, Trash2, Usb } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Types ────────────────────────────────────────────────────

interface Credential {
  id: string;
  displayName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[] | null;
}

// ── Helpers ──────────────────────────────────────────────────

function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { "x-csrf-token": token } : {};
}

const TRANSPORT_ICONS: Record<string, typeof Usb> = {
  usb: Usb,
  ble: Bluetooth,
  nfc: Nfc,
  internal: Fingerprint,
};

// ── WebAuthnCard (exported) ──────────────────────────────────

export function WebAuthnCard() {
  const t = useTranslations("profile.webauthn");

  const [enrolled, setEnrolled] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Credential | null>(null);
  const [renameTarget, setRenameTarget] = useState<Credential | null>(null);
  const adminDisabled = enrolled && !allowed;

  const fetchStatus = useCallback(() => {
    setFetchError(false);
    Promise.all([
      fetch("/api/auth/mfa/webauthn/status").then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      }),
      fetch("/api/auth/mfa/webauthn/credentials").then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      }),
    ])
      .then(([status, creds]) => {
        setEnrolled(status.enrolled);
        setAllowed(status.allowed);
        setCredentials(creds.credentials);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  function handleRegisterComplete() {
    setRegisterOpen(false);
    fetchStatus();
  }

  function handleRemoveComplete() {
    setRemoveTarget(null);
    fetchStatus();
  }

  function handleRenameComplete() {
    setRenameTarget(null);
    fetchStatus();
  }

  if (loading) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {fetchError ? (
            <p className="text-destructive text-sm" role="alert">
              {t("registerError")}
            </p>
          ) : (
            <>
              <Badge variant={enrolled ? "default" : "secondary"}>
                {enrolled ? t("enabled") : t("disabled")}
              </Badge>
              {enrolled && (
                <CredentialList
                  credentials={credentials}
                  t={t}
                  adminDisabled={adminDisabled}
                  onRename={setRenameTarget}
                  onRemove={setRemoveTarget}
                />
              )}
            </>
          )}
        </CardContent>
        {!fetchError && (
          <CardFooter>
            {enrolled ? (
              <div className="space-y-2">
                {adminDisabled && (
                  <p className="text-muted-foreground text-sm">
                    {t("disabledByAdmin")}
                  </p>
                )}
                {allowed && (
                  <Button onClick={() => setRegisterOpen(true)}>
                    {t("addPasskey")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {!allowed ? (
                  <p className="text-muted-foreground text-sm">
                    {t("notAvailable")}
                  </p>
                ) : (
                  <Button onClick={() => setRegisterOpen(true)}>
                    {t("register")}
                  </Button>
                )}
              </div>
            )}
          </CardFooter>
        )}
      </Card>

      <WebAuthnRegisterDialog
        open={registerOpen}
        onOpenChange={(isOpen) => {
          setRegisterOpen(isOpen);
          if (!isOpen) fetchStatus();
        }}
        onComplete={handleRegisterComplete}
      />

      <WebAuthnRemoveDialog
        credential={removeTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoveTarget(null);
        }}
        onComplete={handleRemoveComplete}
      />

      <WebAuthnRenameDialog
        credential={renameTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRenameTarget(null);
        }}
        onComplete={handleRenameComplete}
      />
    </>
  );
}

// ── CredentialList ───────────────────────────────────────────

function CredentialList({
  credentials,
  t,
  adminDisabled,
  onRename,
  onRemove,
}: {
  credentials: Credential[];
  t: ReturnType<typeof useTranslations>;
  adminDisabled: boolean;
  onRename: (c: Credential) => void;
  onRemove: (c: Credential) => void;
}) {
  if (credentials.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{t("noCredentials")}</p>
    );
  }

  return (
    <ul className="divide-border divide-y" data-testid="credential-list">
      {credentials.map((cred) => (
        <li key={cred.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {cred.displayName || t("title")}
            </p>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 text-xs">
              <span>
                {t("createdAt")} {new Date(cred.createdAt).toLocaleDateString()}
              </span>
              <span>
                {cred.lastUsedAt
                  ? `${t("lastUsedAt")} ${new Date(cred.lastUsedAt).toLocaleDateString()}`
                  : t("neverUsed")}
              </span>
            </div>
            {cred.transports && cred.transports.length > 0 && (
              <div className="mt-1 flex gap-1">
                {cred.transports.map((transport) => {
                  const Icon = TRANSPORT_ICONS[transport];
                  return Icon ? (
                    <Icon
                      key={transport}
                      className="text-muted-foreground h-3.5 w-3.5"
                      aria-label={transport}
                    />
                  ) : null;
                })}
              </div>
            )}
          </div>
          {!adminDisabled && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onRename(cred)}
              aria-label={t("rename")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(cred)}
            aria-label={t("remove")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ── WebAuthnRegisterDialog ──────────────────────────────────

function WebAuthnRegisterDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.webauthn");

  const [step, setStep] = useState<"form" | "success">("form");
  const [displayName, setDisplayName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setStep("form");
      setDisplayName("");
      setRegistering(false);
      setError("");
    }
  }, [open]);

  async function handleRegister() {
    setRegistering(true);
    setError("");

    try {
      // Step 1: Get registration options
      const optionsRes = await fetch(
        "/api/auth/mfa/webauthn/register/options",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
        },
      );

      if (!optionsRes.ok) {
        setError(t("registerError"));
        return;
      }

      const options = await optionsRes.json();

      // Step 2: Start browser registration ceremony
      const credential = await startRegistration({ optionsJSON: options });

      // Step 3: Verify with server
      const verifyRes = await fetch("/api/auth/mfa/webauthn/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          response: credential,
          displayName: displayName || undefined,
        }),
      });

      if (!verifyRes.ok) {
        setError(t("registerError"));
        return;
      }

      setStep("success");
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError(t("registerCancelled"));
      } else {
        setError(t("registerError"));
      }
    } finally {
      setRegistering(false);
    }
  }

  if (step === "success") {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onComplete();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("registerTitle")}</DialogTitle>
            <DialogDescription>{t("registerSuccess")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onComplete}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("registerTitle")}</DialogTitle>
          <DialogDescription>{t("registerDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webauthn-display-name">
              {t("displayNameLabel")}
            </Label>
            <Input
              id="webauthn-display-name"
              placeholder={t("displayNamePlaceholder")}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button onClick={handleRegister} disabled={registering}>
            {registering ? t("registering") : t("register")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── WebAuthnRemoveDialog ────────────────────────────────────

function WebAuthnRemoveDialog({
  credential,
  onOpenChange,
  onComplete,
}: {
  credential: Credential | null;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.webauthn");

  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!credential) {
      setPassword("");
      setLoading(false);
      setError("");
    }
  }, [credential]);

  async function handleRemove() {
    if (!credential) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch(
        `/api/auth/mfa/webauthn/credentials/${credential.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
          body: JSON.stringify({ password }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.code === "INVALID_PASSWORD") {
          setError(t("invalidPassword"));
        } else if (body?.code === "WEBAUTHN_NOT_FOUND") {
          onComplete();
        } else {
          setError(t("removeError"));
        }
        return;
      }

      onComplete();
    } catch {
      setError(t("removeError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={!!credential} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("removeDescription", {
              name: credential?.displayName || t("title"),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="webauthn-remove-password">{t("passwordLabel")}</Label>
          <Input
            id="webauthn-remove-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleRemove}
            disabled={!password || loading}
          >
            {loading ? t("removing") : t("remove")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── WebAuthnRenameDialog ────────────────────────────────────

function WebAuthnRenameDialog({
  credential,
  onOpenChange,
  onComplete,
}: {
  credential: Credential | null;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("profile.webauthn");

  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (credential) {
      setDisplayName(credential.displayName || "");
    } else {
      setDisplayName("");
      setLoading(false);
      setError("");
    }
  }, [credential]);

  async function handleRename() {
    if (!credential) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch(
        `/api/auth/mfa/webauthn/credentials/${credential.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
          body: JSON.stringify({ displayName }),
        },
      );

      if (!res.ok) {
        setError(t("renameError"));
        return;
      }

      onComplete();
    } catch {
      setError(t("renameError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={!!credential} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="webauthn-rename-input">{t("displayNameLabel")}</Label>
          <Input
            id="webauthn-rename-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button onClick={handleRename} disabled={!displayName || loading}>
            {loading ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
