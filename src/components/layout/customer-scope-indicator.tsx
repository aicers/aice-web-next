"use client";

import { AlertTriangle, ChevronDown, Shield, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import type { EffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { cn } from "@/lib/utils";

const FEW_THRESHOLD = 3;

type Variant = "desktop" | "mobile";

/**
 * Build the pill label for a given scope. The desktop layout has room
 * for the full "Customers: ACME, Beta, Gamma" formatter; the mobile
 * header collapses to a name-only pill in the single-customer case and
 * a count pill in the multi/admin cases (per #383). A pure function so
 * tests exercise both variants without rendering.
 */
export function formatScopeLabel(
  scope: EffectiveCustomerScope,
  t: (key: string, values?: Record<string, string | number>) => string,
  variant: Variant = "desktop",
): string {
  if (variant === "mobile") {
    if (scope.kind === "admin") return t("mobileAll");
    if (scope.kind === "empty" || scope.customers.length === 0)
      return t("mobileEmpty");
    if (scope.customers.length === 1)
      return t("mobileSingle", { name: scope.customers[0].name });
    return t("mobileCount", { count: scope.customers.length });
  }

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
   * `false`, the popover/sheet omits the management link.
   */
  canManage?: boolean;
  /**
   * Layout variant. `desktop` renders the full label inline with a
   * popover; `mobile` renders a compact name-or-count pill that opens
   * the detail panel as a bottom sheet.
   */
  variant?: Variant;
  className?: string;
}

/**
 * Right-aligned passive indicator surfaced in the breadcrumb bar
 * (desktop) and the mobile header. Shows the session's effective
 * customer scope so multi-tenant operators can see which slice of the
 * system they are looking at without leaving the page.
 *
 * The component is intentionally read-only — clicking it opens a
 * popover (desktop) or sheet (mobile) with the full customer list and
 * the source of the scope, but it does not offer a "switch to customer
 * X" affordance. That interactive switcher is tracked separately under
 * future considerations (Discussion #381).
 */
export function CustomerScopeIndicator({
  scope,
  canManage = false,
  variant = "desktop",
  className,
}: CustomerScopeIndicatorProps) {
  const t = useTranslations("multitenancy.scope");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (variant !== "desktop") return;
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
  }, [open, variant]);

  const label = formatScopeLabel(
    scope,
    (key, values) => t(key, values),
    variant,
  );
  const isAdmin = scope.kind === "admin";
  const isEmpty = scope.kind === "empty";
  const Icon = isEmpty ? AlertTriangle : isAdmin ? Shield : Users;
  const isMobile = variant === "mobile";

  const button = (
    <button
      type="button"
      aria-label={t("openLabel")}
      aria-expanded={open}
      aria-haspopup={isMobile ? "dialog" : "dialog"}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-full border text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
        isMobile ? "max-w-[10rem] px-2 py-1" : "max-w-[16rem] px-3 py-1.5",
        isEmpty
          ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "border-border bg-muted text-foreground hover:bg-accent",
      )}
      data-testid="customer-scope-indicator"
      data-scope-kind={scope.kind}
      data-variant={variant}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {isAdmin && !isMobile ? (
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
  );

  if (isMobile) {
    return (
      <div className={cn("inline-flex items-center", className)}>
        {button}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="h-auto max-h-[80vh] gap-0 rounded-t-lg pb-6"
          >
            <SheetHeader className="px-4 pt-4">
              <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
                {t("popoverTitle")}
                {isAdmin ? (
                  <Badge
                    variant="outline"
                    className="h-4 px-1 py-0 text-[10px] leading-none"
                  >
                    {t("adminBadge")}
                  </Badge>
                ) : null}
              </SheetTitle>
            </SheetHeader>
            <CustomerScopeDetails
              scope={scope}
              canManage={canManage}
              className="px-4 pt-2"
            />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={cn("relative inline-flex items-center", className)}
    >
      {button}
      {open ? (
        <CustomerScopePopover scope={scope} canManage={canManage} />
      ) : null}
    </div>
  );
}

interface CustomerScopeDetailsProps {
  scope: EffectiveCustomerScope;
  canManage: boolean;
  className?: string;
}

/**
 * Shared inner content for the desktop popover and the mobile sheet.
 * Lists every customer in scope (so the 4+ "+N more" case has somewhere
 * to surface the full roster) and labels the source of the scope.
 */
export function CustomerScopeDetails({
  scope,
  canManage,
  className,
}: CustomerScopeDetailsProps) {
  const t = useTranslations("multitenancy.scope");
  const sourceLabel =
    scope.kind === "admin"
      ? t("sourceAdmin")
      : scope.kind === "empty"
        ? t("sourceEmpty")
        : t("sourceAssigned");

  return (
    <div className={className}>
      <p className="text-muted-foreground text-xs">{sourceLabel}</p>
      {scope.customers.length > 0 ? (
        <ul className="mt-2 max-h-56 overflow-auto text-sm">
          {scope.customers.map((customer) => (
            <li
              key={customer.id}
              className="text-foreground border-border/40 truncate border-t py-1 first:border-t-0"
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

interface CustomerScopePopoverProps {
  scope: EffectiveCustomerScope;
  canManage: boolean;
}

/**
 * Detail panel anchored under the indicator on desktop. The mobile
 * variant uses a `<Sheet>` instead so the same information can fit a
 * narrow viewport without overflowing the header.
 */
export function CustomerScopePopover({
  scope,
  canManage,
}: CustomerScopePopoverProps) {
  const t = useTranslations("multitenancy.scope");

  return (
    <div
      role="dialog"
      aria-label={t("popoverTitle")}
      className="bg-popover text-popover-foreground absolute top-full right-0 z-30 mt-2 w-72 rounded-md border p-3 shadow-md"
    >
      <p className="text-foreground text-xs font-semibold tracking-wide uppercase">
        {t("popoverTitle")}
      </p>
      <CustomerScopeDetails
        scope={scope}
        canManage={canManage}
        className="mt-1"
      />
    </div>
  );
}
