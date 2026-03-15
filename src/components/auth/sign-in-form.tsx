"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
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

export function SignInForm() {
  const t = useTranslations("auth");
  const tValidation = useTranslations("validation");
  const router = useRouter();

  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { username: "", password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: SignInValues) {
    setServerError(null);

    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        const body = (await res.json()) as { mustChangePassword?: boolean };
        if (body.mustChangePassword) {
          router.push("/change-password");
        } else {
          router.push("/");
        }
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
          const knownCodes: Record<string, string> = {
            INVALID_CREDENTIALS: "invalidCredentials",
            ACCOUNT_LOCKED: "accountLocked",
            ACCOUNT_INACTIVE: "accountInactive",
            IP_RESTRICTED: "ipRestricted",
            MAX_SESSIONS: "maxSessions",
          };
          const key = knownCodes[body.code];
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
