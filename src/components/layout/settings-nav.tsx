"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface SettingsNavProps {
  showAccounts?: boolean;
  showRoles?: boolean;
  showCustomers?: boolean;
  showPolicies?: boolean;
  showTriageExclusions?: boolean;
  /**
   * Show the global Triage exclusions tab. Gated separately from the
   * per-customer page (which only needs `triage:read`) because the
   * global table is ops-managed and only operators with
   * `triage:exclusion:global:write` can mutate it. We still surface the
   * link to anyone with `triage:read` so a Security Monitor can see
   * what is in effect at the global scope; mutate buttons inside the
   * page gate on the write permission separately.
   */
  showTriageExclusionsGlobal?: boolean;
  showAccountStatus?: boolean;
  showAimerIntegration?: boolean;
}

export function SettingsNav({
  showAccounts,
  showRoles,
  showCustomers,
  showPolicies,
  showTriageExclusions,
  showTriageExclusionsGlobal,
  showAccountStatus,
  showAimerIntegration,
}: SettingsNavProps) {
  const t = useTranslations("settings");
  const pathname = usePathname();

  const items: { key: string; href: string; matchExact?: boolean }[] = [];
  if (showAccounts) items.push({ key: "accounts", href: "/settings/accounts" });
  if (showRoles) items.push({ key: "roles", href: "/settings/roles" });
  if (showCustomers)
    items.push({ key: "customers", href: "/settings/customers" });
  if (showPolicies) items.push({ key: "policies", href: "/settings/policies" });
  if (showTriageExclusions)
    items.push({
      key: "triageExclusions",
      href: "/settings/triage-exclusions",
      // The global page lives at `/settings/triage-exclusions/global`,
      // which would otherwise both highlight as active under the
      // `startsWith` check. Constrain this entry to its exact path so
      // the two siblings highlight independently.
      matchExact: true,
    });
  if (showTriageExclusionsGlobal)
    items.push({
      key: "triageExclusionsGlobal",
      href: "/settings/triage-exclusions/global",
    });
  if (showAccountStatus)
    items.push({ key: "accountStatus", href: "/settings/account-status" });
  if (showAimerIntegration)
    items.push({
      key: "aimerIntegration",
      href: "/settings/aimer-integration",
    });

  if (items.length === 0) return null;

  return (
    <nav className="flex gap-1">
      {items.map((item) => {
        const active = item.matchExact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.key}
            href={item.href}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
