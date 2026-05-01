"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
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

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1),
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
  });

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

export function ChangePasswordForm() {
  const t = useTranslations("changePassword");
  const tValidation = useTranslations("validation");
  const router = useRouter();

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: ChangePasswordValues) {
    setServerError(null);

    try {
      const csrfToken = readCsrfToken();
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken ?? "",
          Origin: window.location.origin,
        },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });

      if (res.ok) {
        router.push("/");
        return;
      }

      if (res.status === 401) {
        setServerError(t("incorrectPassword"));
        return;
      }

      if (res.status === 429) {
        setServerError(t("rateLimited"));
        return;
      }

      if (res.status === 400) {
        try {
          const body = (await res.json()) as { codes?: string[] };
          if (body.codes && body.codes.length > 0) {
            const errorMessages = body.codes
              .map((code) => {
                try {
                  return t(`errors.${code}` as Parameters<typeof t>[0]);
                } catch {
                  return code;
                }
              })
              .join(". ");
            setServerError(errorMessages);
            return;
          }
        } catch {
          // fall through
        }
      }

      setServerError(t("serverError"));
    } catch {
      setServerError(t("serverError"));
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-6">
        <h1 className="text-xl font-semibold tracking-tight">{t("heading")}</h1>

        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("currentPassword")}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    type={showCurrentPassword ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus
                    disabled={isSubmitting}
                    className="pr-10"
                    {...field}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowCurrentPassword((prev) => !prev)}
                  >
                    {showCurrentPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
              </FormControl>
              <FormMessage>
                {form.formState.errors.currentPassword &&
                  tValidation("required", { field: t("currentPassword") })}
              </FormMessage>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("newPassword")}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    type={showNewPassword ? "text" : "password"}
                    autoComplete="new-password"
                    disabled={isSubmitting}
                    className="pr-10"
                    {...field}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowNewPassword((prev) => !prev)}
                  >
                    {showNewPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
              </FormControl>
              <FormMessage>
                {form.formState.errors.newPassword &&
                  tValidation("required", { field: t("newPassword") })}
              </FormMessage>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("confirmPassword")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage>
                {form.formState.errors.confirmPassword &&
                  tValidation("passwordMismatch")}
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
              {t("submitting")}
            </>
          ) : (
            t("submit")
          )}
        </Button>
      </form>
    </Form>
  );
}
