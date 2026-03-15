"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface SettingsNavProps {
  showAccounts?: boolean;
  showRoles?: boolean;
  showCustomers?: boolean;
  showSystem?: boolean;
}

export function SettingsNav({
  showAccounts,
  showRoles,
  showCustomers,
  showSystem,
}: SettingsNavProps) {
  const t = useTranslations("settings");
  const pathname = usePathname();

  const items: { key: string; href: string }[] = [];
  if (showAccounts) items.push({ key: "accounts", href: "/settings/accounts" });
  if (showRoles) items.push({ key: "roles", href: "/settings/roles" });
  if (showCustomers)
    items.push({ key: "customers", href: "/settings/customers" });
  if (showSystem) items.push({ key: "system", href: "/settings/system" });

  if (items.length === 0) return null;

  return (
    <nav className="flex gap-1 border-b">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
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
