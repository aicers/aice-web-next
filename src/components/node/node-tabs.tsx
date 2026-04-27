"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "status", href: "/nodes" },
  { key: "settings", href: "/nodes/settings" },
] as const;

export function NodeTabs() {
  const t = useTranslations("nodes.tabs");
  const pathname = usePathname();

  return (
    <nav aria-label="Nodes navigation" className="flex gap-1">
      {TABS.map((tab) => {
        // Status (`/nodes`) is the default landing; we cannot do a
        // simple `startsWith` because every `/nodes/...` path would
        // also match. Instead, mark Status active when the path is
        // `/nodes` exactly or a descendant that is not the Settings
        // sub-tree (the detail page `/nodes/<id>` reads as Status
        // until a future tab overrides it).
        const active =
          tab.href === "/nodes"
            ? pathname === "/nodes" || !pathname.startsWith("/nodes/settings")
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            data-testid={`nodes-tab-${tab.key}`}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
