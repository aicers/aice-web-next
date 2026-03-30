"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { startAuthentication } from "@simplewebauthn/browser";
import {
  AlertCircle,
  ArrowLeft,
  Eye,
  EyeOff,
  Fingerprint,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";

const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

type SignInValues = z.infer<typeof signInSchema>;

const ERROR_KEYS: Record<number, string> = {
  429: "rateLimited",
};

const KNOWN_CODES: Record<string, string> = {
  INVALID_CREDENTIALS: "invalidCredentials",
  ACCOUNT_LOCKED: "accountLocked",
  ACCOUNT_INACTIVE: "accountInactive",
  IP_RESTRICTED: "ipRestricted",
  MAX_SESSIONS: "maxSessions",
};

const MFA_CODES: Record<string, string> = {
  INVALID_MFA_CODE: "mfa.invalidCode",
  MFA_TOKEN_INVALID: "mfa.mfaTokenExpired",
  TOTP_NOT_ALLOWED: "mfa.totpDisabledMidFlow",
  WEBAUTHN_NOT_ALLOWED: "mfa.webauthnDisabledMidFlow",
  MFA_RATE_LIMITED: "mfa.rateLimited",
};

export function SignInForm() {
  const t = useTranslations("auth");
  const tValidation = useTranslations("validation");
  const router = useRouter();

  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // MFA state
  const [mfaStep, setMfaStep] = useState<"credentials" | "totp" | "webauthn">(
    "credentials",
  );
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [totpCode, setTotpCode] = useState("");
  const [mfaSubmitting, setMfaSubmitting] = useState(false);
  const [webauthnCancelled, setWebauthnCancelled] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { username: "", password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  const handleSignInSuccess = useCallback(
    (body: { mustChangePassword?: boolean }) => {
      if (body.mustChangePassword) {
        router.push("/change-password");
      } else {
        router.push("/");
      }
    },
    [router],
  );

  const startWebAuthnFlow = useCallback(
    async (token: string) => {
      setServerError(null);
      setWebauthnCancelled(false);
      setMfaSubmitting(true);

      try {
        // Step 1: Get assertion options
        const optionsRes = await fetch(
          "/api/auth/mfa/webauthn/challenge/options",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mfaToken: token }),
          },
        );

        if (!optionsRes.ok) {
          const body = (await optionsRes.json().catch(() => ({}))) as {
            code?: string;
          };
          if (body.code === "MFA_TOKEN_INVALID") {
            setMfaStep("credentials");
            setMfaToken(null);
            setServerError(t("mfa.mfaTokenExpired"));
            return;
          }
          if (body.code === "WEBAUTHN_NOT_ALLOWED") {
            setMfaStep("credentials");
            setMfaToken(null);
            setServerError(t("mfa.webauthnDisabledMidFlow"));
            return;
          }
          setServerError(t("mfa.webauthnError"));
          return;
        }

        const options = await optionsRes.json();

        // Step 2: Trigger browser authenticator prompt
        const assertionResponse = await startAuthentication({
          optionsJSON: options,
        });

        // Step 3: Submit assertion to server
        const verifyRes = await fetch("/api/auth/mfa/webauthn/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mfaToken: token,
            response: assertionResponse,
          }),
        });

        if (verifyRes.ok) {
          const body = (await verifyRes.json()) as {
            mustChangePassword?: boolean;
          };
          handleSignInSuccess(body);
          return;
        }

        // Handle rate limit
        if (verifyRes.status === 429) {
          setServerError(t("mfa.rateLimited"));
          return;
        }

        const body = (await verifyRes.json().catch(() => ({}))) as {
          code?: string;
        };
        if (body.code) {
          if (body.code === "MFA_TOKEN_INVALID") {
            setMfaStep("credentials");
            setMfaToken(null);
            setServerError(t("mfa.mfaTokenExpired"));
            return;
          }
          if (body.code === "WEBAUTHN_NOT_ALLOWED") {
            setMfaStep("credentials");
            setMfaToken(null);
            setServerError(t("mfa.webauthnDisabledMidFlow"));
            return;
          }
          const mfaKey = MFA_CODES[body.code];
          if (mfaKey) {
            setServerError(t(mfaKey));
            return;
          }
          const sharedKey = KNOWN_CODES[body.code];
          if (sharedKey) {
            setServerError(t(sharedKey));
            return;
          }
        }
        setServerError(t("mfa.webauthnError"));
      } catch (err) {
        // User cancelled the browser prompt
        if (err instanceof Error && err.name === "NotAllowedError") {
          setWebauthnCancelled(true);
          setServerError(t("mfa.webauthnCancelled"));
          return;
        }
        setServerError(t("mfa.webauthnError"));
      } finally {
        setMfaSubmitting(false);
      }
    },
    [t, handleSignInSuccess],
  );

  async function onSubmit(values: SignInValues) {
    setServerError(null);

    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          mustChangePassword?: boolean;
          mfaRequired?: boolean;
          mfaToken?: string;
          mfaMethods?: string[];
        };

        if (body.mfaRequired && body.mfaToken) {
          const methods = body.mfaMethods ?? [];
          setMfaToken(body.mfaToken);
          setMfaMethods(methods);

          // Default to WebAuthn if available, otherwise TOTP
          if (methods.includes("webauthn")) {
            setMfaStep("webauthn");
            startWebAuthnFlow(body.mfaToken);
          } else {
            setMfaStep("totp");
            setTotpCode("");
            setTimeout(() => totpInputRef.current?.focus(), 0);
          }
          return;
        }

        handleSignInSuccess(body);
        return;
      }

      // Map known status codes to i18n keys
      const errorKey = ERROR_KEYS[res.status];
      if (errorKey) {
        setServerError(t(errorKey));
        return;
      }

      // Try to extract error code from response body
      try {
        const body = (await res.json()) as { code?: string };
        if (body.code) {
          const key = KNOWN_CODES[body.code];
          if (key) {
            setServerError(t(key));
            return;
          }
        }
      } catch {
        // Response body is not JSON — fall through to generic error
      }

      setServerError(t("serverError"));
    } catch {
      setServerError(t("serverError"));
    }
  }

  async function onTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setMfaSubmitting(true);

    try {
      const res = await fetch("/api/auth/mfa/totp/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaToken, code: totpCode }),
      });

      if (res.ok) {
        const body = (await res.json()) as { mustChangePassword?: boolean };
        handleSignInSuccess(body);
        return;
      }

      // Handle rate limit
      if (res.status === 429) {
        setServerError(t("mfa.rateLimited"));
        return;
      }

      // Try to extract error code
      try {
        const body = (await res.json()) as { code?: string };
        if (body.code) {
          // MFA token expired or invalid — restart sign-in
          if (body.code === "MFA_TOKEN_INVALID") {
            setMfaStep("credentials");
            setMfaToken(null);
            setTotpCode("");
            setServerError(t("mfa.mfaTokenExpired"));
            return;
          }

          // TOTP disabled mid-flow — restart sign-in
          if (body.code === "TOTP_NOT_ALLOWED") {
            setMfaStep("credentials");
            setMfaToken(null);
            setTotpCode("");
            setServerError(t("mfa.totpDisabledMidFlow"));
            return;
          }

          // Check MFA-specific codes
          const mfaKey = MFA_CODES[body.code];
          if (mfaKey) {
            setServerError(t(mfaKey));
            setTotpCode("");
            return;
          }

          // Check shared codes (ACCOUNT_LOCKED, etc.)
          const sharedKey = KNOWN_CODES[body.code];
          if (sharedKey) {
            setServerError(t(sharedKey));
            return;
          }
        }
      } catch {
        // Response body is not JSON
      }

      setServerError(t("serverError"));
    } catch {
      setServerError(t("serverError"));
    } finally {
      setMfaSubmitting(false);
    }
  }

  function resetToCredentials() {
    setMfaStep("credentials");
    setMfaToken(null);
    setMfaMethods([]);
    setTotpCode("");
    setWebauthnCancelled(false);
    setServerError(null);
  }

  // ── WebAuthn step ─────────────────────────────────────────────

  if (mfaStep === "webauthn") {
    return (
      <div className="grid gap-6">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("mfa.usePasskey")}
        </h1>

        <div className="flex flex-col items-center gap-4 py-4">
          <Fingerprint className="text-muted-foreground size-12" />
          <p className="text-muted-foreground text-center text-sm">
            {t("mfa.passkeyPrompt")}
          </p>
        </div>

        {serverError && (
          <p
            className="text-destructive flex items-center gap-1 text-sm"
            role="alert"
          >
            <AlertCircle className="size-3.5 shrink-0" />
            {serverError}
          </p>
        )}

        {(webauthnCancelled || serverError) && !mfaSubmitting && (
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              if (mfaToken) startWebAuthnFlow(mfaToken);
            }}
          >
            {t("mfa.webauthnRetry")}
          </Button>
        )}

        {mfaSubmitting && (
          <Button type="button" className="w-full" disabled>
            <Loader2 className="animate-spin" />
            {t("mfa.verifying")}
          </Button>
        )}

        {mfaMethods.includes("totp") && (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setMfaStep("totp");
              setServerError(null);
              setWebauthnCancelled(false);
              setTotpCode("");
              setTimeout(() => totpInputRef.current?.focus(), 0);
            }}
            disabled={mfaSubmitting}
          >
            {t("mfa.useTotp")}
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={resetToCredentials}
          disabled={mfaSubmitting}
        >
          <ArrowLeft className="size-4" />
          {t("mfa.backToSignIn")}
        </Button>
      </div>
    );
  }

  // ── TOTP step ───────────────────────────────────────────────

  if (mfaStep === "totp") {
    return (
      <form onSubmit={onTotpSubmit} className="grid gap-6">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("mfa.enterTotpCode")}
        </h1>

        <div className="grid gap-2">
          <Input
            ref={totpInputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            value={totpCode}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setTotpCode(v);
            }}
            disabled={mfaSubmitting}
            className="text-center text-lg tracking-widest"
            autoFocus
          />
        </div>

        {serverError && (
          <p
            className="text-destructive flex items-center gap-1 text-sm"
            role="alert"
          >
            <AlertCircle className="size-3.5 shrink-0" />
            {serverError}
          </p>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={mfaSubmitting || totpCode.length !== 6}
        >
          {mfaSubmitting ? (
            <>
              <Loader2 className="animate-spin" />
              {t("mfa.verifying")}
            </>
          ) : (
            t("mfa.verifyButton")
          )}
        </Button>

        {mfaMethods.includes("webauthn") && (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setMfaStep("webauthn");
              setServerError(null);
              setTotpCode("");
              if (mfaToken) startWebAuthnFlow(mfaToken);
            }}
            disabled={mfaSubmitting}
          >
            {t("mfa.useWebauthn")}
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={resetToCredentials}
          disabled={mfaSubmitting}
        >
          <ArrowLeft className="size-4" />
          {t("mfa.backToSignIn")}
        </Button>
      </form>
    );
  }

  // ── Credentials step ────────────────────────────────────────

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-6">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("signInHeading")}
        </h1>

        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("username")}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="username"
                  autoFocus
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage>
                {form.formState.errors.username &&
                  tValidation("required", { field: t("username") })}
              </FormMessage>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("password")}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    disabled={isSubmitting}
                    className="pr-10"
                    {...field}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword ? t("hidePassword") : t("showPassword")
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
              </FormControl>
              <FormMessage>
                {form.formState.errors.password &&
                  tValidation("required", { field: t("password") })}
              </FormMessage>
            </FormItem>
          )}
        />

        {serverError && (
          <p
            className="text-destructive flex items-center gap-1 text-sm"
            role="alert"
          >
            <AlertCircle className="size-3.5 shrink-0" />
            {serverError}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="animate-spin" />
              {t("signingIn")}
            </>
          ) : (
            t("signInButton")
          )}
        </Button>
      </form>
    </Form>
  );
}
