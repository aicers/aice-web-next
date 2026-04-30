"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";

import type { EffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { cn } from "@/lib/utils";

interface CustomerScopeCalloutProps {
  scope: EffectiveCustomerScope;
  className?: string;
}

/**
 * Subheader callout reminding multi-tenant operators that the page
 * aggregates data across more than one customer. Single-customer and
 * admin sessions skip this callout — single is implicit, admins know.
 */
export function CustomerScopeCallout({
  scope,
  className,
}: CustomerScopeCalloutProps) {
  const t = useTranslations("multitenancy.scope");
  if (scope.kind !== "assigned" || scope.customers.length <= 1) return null;

  return (
    <div
      className={cn(
        "border-border bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
        className,
      )}
      data-testid="customer-scope-callout"
    >
      <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{t("callout", { count: scope.customers.length })}</span>
    </div>
  );
}
