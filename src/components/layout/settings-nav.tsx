"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface SettingsNavProps {
  showSystem?: boolean;
}

const ITEMS = [
  { key: "accounts", href: "/settings/accounts" },
  { key: "customers", href: "/settings/customers" },
] as const;

export function SettingsNav({ showSystem }: SettingsNavProps) {
  const t = useTranslations("settings");
  const pathname = usePathname();

  const items = showSystem
    ? [...ITEMS, { key: "system" as const, href: "/settings/system" }]
    : ITEMS;

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
