"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { parseBreadcrumbs } from "@/lib/breadcrumbs";
import { cn } from "@/lib/utils";

export function Breadcrumbs() {
  const pathname = usePathname();
  const tNav = useTranslations("nav");
  const tSettings = useTranslations("settings");

  const crumbs = parseBreadcrumbs(pathname, (ns, key) => {
    if (ns === "nav") return tNav(key);
    if (ns === "settings") return tSettings(key);
    return null;
  });

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={crumb.href}>
            {index > 0 && (
              <ChevronRight className="text-muted-foreground h-3.5 w-3.5" />
            )}
            {isLast ? (
              <span className="text-foreground font-medium">{crumb.label}</span>
            ) : (
              <Link
                href={crumb.href}
                className={cn(
                  "text-muted-foreground hover:text-foreground transition-colors",
                )}
              >
                {crumb.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
