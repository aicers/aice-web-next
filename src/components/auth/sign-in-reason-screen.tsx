"use client";

import { Clock, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

const SCREENS = {
  "signed-out": {
    icon: LogOut,
    headingKey: "signedOutHeading",
    descriptionKey: "signedOutDescription",
  },
  "session-ended": {
    icon: Clock,
    headingKey: "sessionEndedHeading",
    descriptionKey: "sessionEndedDescription",
  },
} as const;

export type SignInReason = keyof typeof SCREENS;

export function SignInReasonScreen({ reason }: { reason: SignInReason }) {
  const t = useTranslations("auth");
  const screen = SCREENS[reason];
  const Icon = screen.icon;

  return (
    <div className="grid gap-6 text-center">
      <div className="flex justify-center">
        <div className="bg-muted flex size-12 items-center justify-center rounded-full">
          <Icon className="text-muted-foreground size-6" />
        </div>
      </div>

      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {t(screen.headingKey)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(screen.descriptionKey)}
        </p>
      </div>

      <Button asChild className="w-full">
        <Link href="/sign-in">{t("signInAgain")}</Link>
      </Button>
    </div>
  );
}
