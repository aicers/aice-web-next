"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/review/sign-in";

type SignInFormValues = {
  username: string;
  password: string;
};

export function SignInForm() {
  const t = useTranslations("signin");
  const { token, expirationTime, setAuthPayload } = useAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const usernameId = useId();
  const passwordId = useId();

  const schema = useMemo(
    () =>
      z.object({
        username: z
          .string()
          .min(1, { message: t("validation.username.required") }),
        password: z
          .string()
          .min(1, { message: t("validation.password.required") }),
      }),
    [t],
  );

  const form = useForm<SignInFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result = await signIn(values);
      setAuthPayload(result);
    } catch (error) {
      console.error("Unable to sign in", error);
      const message =
        error instanceof Error
          ? `${t("error")}
${error.message}`
          : t("error");
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  });

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <div className="space-y-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={usernameId}
        >
          {t("username.label")}
        </label>
        <Input
          autoComplete="username"
          data-testid="signin-username"
          id={usernameId}
          {...form.register("username")}
        />
        {form.formState.errors.username && (
          <p className="text-sm text-destructive">
            {form.formState.errors.username.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={passwordId}
        >
          {t("password.label")}
        </label>
        <Input
          autoComplete="current-password"
          data-testid="signin-password"
          id={passwordId}
          type="password"
          {...form.register("password")}
        />
        {form.formState.errors.password && (
          <p className="text-sm text-destructive">
            {form.formState.errors.password.message}
          </p>
        )}
      </div>

      {errorMessage ? (
        <pre className="whitespace-pre-wrap text-sm text-destructive">
          {errorMessage}
        </pre>
      ) : null}

      {token ? (
        <div
          className="space-y-2 rounded-md border border-border bg-muted/30 p-4 text-sm"
          data-testid="signin-token-container"
        >
          <p className="font-medium text-foreground">{t("success")}</p>
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              {t("token.label")}
            </p>
            <code className="block break-all text-xs text-foreground">
              {token}
            </code>
          </div>
          {expirationTime ? (
            <p className="text-xs text-muted-foreground">
              {t("token.expires", {
                expiration: new Date(expirationTime),
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      <Button
        className="w-full justify-center"
        disabled={isSubmitting}
        data-testid="signin-submit"
        type="submit"
      >
        {isSubmitting ? `${t("submit")}...` : t("submit")}
      </Button>
    </form>
  );
}
