"use client";

import { CloudOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

export function ManagerUnavailablePanel() {
  const t = useTranslations("nodes.managerUnavailable");

  return (
    <div
      data-testid="manager-unavailable-panel"
      className="rounded-lg border border-dashed bg-card px-6 py-12 text-center"
    >
      <CloudOff
        className="text-muted-foreground mx-auto mb-4 h-10 w-10"
        aria-hidden="true"
      />
      <h2 className="text-foreground text-lg font-semibold">{t("title")}</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
        {t("description")}
      </p>
      <Button
        variant="outline"
        className="mt-6"
        onClick={() => {
          if (typeof window !== "undefined") window.location.reload();
        }}
      >
        {t("retry")}
      </Button>
    </div>
  );
}
