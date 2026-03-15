"use client";

import type { LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface SidebarItemProps {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed?: boolean;
}

export function SidebarItem({
  href,
  icon: Icon,
  label,
  active = false,
  collapsed = false,
}: SidebarItemProps) {
  const linkContent = (
    <Link
      href={href}
      className={cn(
        "group relative flex h-12 items-center gap-3 px-4 text-base font-medium transition-colors",
        active
          ? "text-[var(--sidebar-fg)]"
          : "text-[var(--sidebar-muted)] hover:text-[var(--sidebar-fg)]",
        collapsed && "justify-center px-0",
      )}
    >
      {/* Active indicator — blue left border bar */}
      {active && (
        <span className="absolute top-0 left-0 h-full w-1 rounded-r-lg bg-[var(--sidebar-active)]" />
      )}
      {/* Active glow — radial gradient from left */}
      {active && (
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at left center, rgba(21, 110, 242, 0.29) 0%, transparent 100%)",
          }}
        />
      )}
      <Icon
        className={cn("relative z-10 size-5 shrink-0", collapsed && "size-6")}
      />
      {!collapsed && <span className="relative z-10">{label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return linkContent;
}
