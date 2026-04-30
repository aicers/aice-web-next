"use client";

import { AlertTriangle, ChevronDown, Shield, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import type { EffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { cn } from "@/lib/utils";

const FEW_THRESHOLD = 3;

/**
 * Build the pill label for a given scope. Pure function so the same
 * formatting rule can be exercised by tests via either rendering or a
 * direct call.
 */
export function formatScopeLabel(
  scope: EffectiveCustomerScope,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (scope.kind === "admin") return t("all");
  if (scope.kind === "empty" || scope.customers.length === 0) return t("empty");
  const names = scope.customers.map((c) => c.name);
  if (names.length === 1) return t("single", { name: names[0] });
  if (names.length <= FEW_THRESHOLD)
    return t("few", { names: names.join(", ") });
  return t("many", { first: names[0], count: names.length - 1 });
}

interface CustomerScopeIndicatorProps {
  scope: EffectiveCustomerScope;
  /**
   * Whether the operator can navigate to /settings/customers. When
   * `false`, the popover omits the management link.
   */
  canManage?: boolean;
  /**
   * Reduces horizontal padding so the pill fits the narrower mobile
   * header without hugging the edge of the viewport.
   */
  compact?: boolean;
  className?: string;
}

/**
 * Right-aligned passive indicator surfaced in the breadcrumb bar
 * (desktop) and the mobile header. Shows the session's effective
 * customer scope so multi-tenant operators can see which slice of the
 * system they are looking at without leaving the page.
 *
 * The component is intentionally read-only — clicking it opens a
 * popover with the full customer list and the source of the scope,
 * but it does not offer a "switch to customer X" affordance. That
 * interactive switcher is tracked separately under future
 * considerations (Discussion #381).
 */
export function CustomerScopeIndicator({
  scope,
  canManage = false,
  compact = false,
  className,
}: CustomerScopeIndicatorProps) {
  const t = useTranslations("multitenancy.scope");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = formatScopeLabel(scope, (key, values) => t(key, values));
  const isAdmin = scope.kind === "admin";
  const isEmpty = scope.kind === "empty";
  const Icon = isEmpty ? AlertTriangle : isAdmin ? Shield : Users;

  return (
    <div
      ref={wrapperRef}
      className={cn("relative inline-flex items-center", className)}
    >
      <button
        type="button"
        aria-label={t("openLabel")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "focus-visible:ring-ring/50 inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
          compact ? "px-2 py-1" : "px-3 py-1.5",
          isEmpty
            ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
            : "border-border bg-muted text-foreground hover:bg-accent",
        )}
        data-testid="customer-scope-indicator"
        data-scope-kind={scope.kind}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {isAdmin ? (
          <Badge
            variant="outline"
            className="h-4 px-1 py-0 text-[10px] leading-none"
          >
            {t("adminBadge")}
          </Badge>
        ) : null}
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open ? "rotate-180" : undefined,
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <CustomerScopePopover scope={scope} canManage={canManage} />
      ) : null}
    </div>
  );
}

interface CustomerScopePopoverProps {
  scope: EffectiveCustomerScope;
  canManage: boolean;
}

/**
 * Detail panel anchored under the indicator. Lists every customer in
 * scope (so the 4+ "+N more" case has somewhere to surface the full
 * roster) and labels the source of the scope so admin and tenant
 * operators see *why* they have the access they have.
 */
export function CustomerScopePopover({
  scope,
  canManage,
}: CustomerScopePopoverProps) {
  const t = useTranslations("multitenancy.scope");
  const sourceLabel =
    scope.kind === "admin"
      ? t("sourceAdmin")
      : scope.kind === "empty"
        ? t("sourceEmpty")
        : t("sourceAssigned");

  return (
    <div
      role="dialog"
      aria-label={t("popoverTitle")}
      className="bg-popover text-popover-foreground absolute top-full right-0 z-30 mt-2 w-72 rounded-md border p-3 shadow-md"
    >
      <p className="text-foreground text-xs font-semibold tracking-wide uppercase">
        {t("popoverTitle")}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">{sourceLabel}</p>
      {scope.customers.length > 0 ? (
        <ul className="mt-2 max-h-56 overflow-auto text-sm">
          {scope.customers.map((customer) => (
            <li
              key={customer.id}
              className="text-foreground truncate border-t border-border/40 py-1 first:border-t-0"
            >
              {customer.name}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <div className="mt-3 border-t pt-2">
          <Link
            href="/settings/customers"
            className="text-primary text-xs hover:underline"
          >
            {t("manageLink")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
