"use client";

import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Home,
  LayoutDashboard,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { TooltipProvider } from "@/components/ui/tooltip";
import { usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { Logo } from "./logo";
import { NavUser } from "./nav-user";
import { SidebarItem } from "./sidebar-item";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  username?: string;
}

const NAV_ITEMS = [
  { key: "home", href: "/home", icon: Home },
  { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
  { key: "event", href: "/event", icon: Radio },
  { key: "detection", href: "/detection", icon: Search },
  { key: "triage", href: "/triage", icon: Shield },
  { key: "report", href: "/report", icon: FileText },
  { key: "audit-logs", href: "/audit-logs", icon: ScrollText },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

export function Sidebar({ collapsed, onToggle, username }: SidebarProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "flex h-full flex-col bg-sidebar transition-[width] duration-200",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Logo / Header */}
        <div
          className={cn(
            "flex shrink-0 items-center px-5 pt-6",
            collapsed ? "justify-center px-0" : "h-16",
          )}
        >
          {collapsed ? <Logo collapsed /> : <Logo />}
        </div>

        {/* Divider */}
        <div className={cn("px-4 pt-6", collapsed && "px-2")}>
          <div className="h-px bg-sidebar-divider" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-3 overflow-y-auto pt-6">
          {NAV_ITEMS.map((item) => (
            <SidebarItem
              key={item.key}
              href={item.href}
              icon={item.icon}
              label={t(item.key)}
              active={pathname.startsWith(item.href)}
              collapsed={collapsed}
            />
          ))}
        </nav>

        {/* Bottom section */}
        <div className={cn("space-y-4 p-4", collapsed && "px-2")}>
          <button
            type="button"
            onClick={onToggle}
            className="flex size-8 items-center justify-center rounded-lg bg-sidebar-divider text-sidebar-muted transition-colors hover:text-sidebar-foreground"
          >
            {collapsed ? (
              <ArrowRight className="size-4" />
            ) : (
              <ArrowLeft className="size-4" />
            )}
            <span className="sr-only">Toggle sidebar</span>
          </button>
          <div className={cn("flex", collapsed ? "justify-center" : "px-0")}>
            <ThemeToggle className="text-sidebar-muted hover:bg-sidebar-divider hover:text-sidebar-foreground" />
          </div>
          <NavUser username={username} collapsed={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
