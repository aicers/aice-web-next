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
  Server,
  Settings,
  Shield,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { TooltipProvider } from "@/components/ui/tooltip";
import { useDetectionReturnNav } from "@/hooks/use-detection-return-nav";
import { usePathname } from "@/i18n/navigation";
import { isNavItemActive } from "@/lib/nav/active-path";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { Logo } from "./logo";
import { NavUser } from "./nav-user";
import { SidebarItem } from "./sidebar-item";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  username?: string;
  /**
   * Absolute aimer-web `/analysis` URL, composed server-side from the
   * integration's bridge URL. `null` / undefined when the aimer-web
   * integration is unconfigured (no bridge URL), in which case the
   * "Open AI analyses" link is hidden entirely (#646).
   */
  aimerAnalysisHref?: string | null;
}

const NAV_ITEMS = [
  { key: "home", href: "/home", icon: Home },
  { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
  { key: "event", href: "/event", icon: Radio },
  { key: "detection", href: "/detection", icon: Search },
  { key: "triage", href: "/triage", icon: Shield },
  { key: "report", href: "/report", icon: FileText },
  { key: "nodes", href: "/nodes/settings", icon: Server },
  { key: "audit-logs", href: "/audit-logs", icon: ScrollText },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

export function Sidebar({
  collapsed,
  onToggle,
  username,
  aimerAnalysisHref,
}: SidebarProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const handleDetectionNav = useDetectionReturnNav();

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "flex h-full flex-col bg-[var(--sidebar-bg)] transition-[width] duration-200",
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
          <div className="h-px bg-[var(--sidebar-border)]" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-3 overflow-y-auto pt-6">
          {NAV_ITEMS.map((item) => (
            <SidebarItem
              key={item.key}
              href={item.href}
              icon={item.icon}
              label={t(item.key)}
              active={isNavItemActive(pathname, item.href)}
              collapsed={collapsed}
              onClick={
                item.key === "detection" ? handleDetectionNav : undefined
              }
            />
          ))}
          {/*
           * Cross-repo deep link into aimer-web's AI analyses surface.
           * Hidden when the integration is unconfigured (no bridge URL
           * resolved server-side). External anchor — the target is an
           * absolute aimer-web URL, not an in-app route.
           */}
          {aimerAnalysisHref ? (
            <SidebarItem
              href={aimerAnalysisHref}
              icon={Sparkles}
              label={t("openAiAnalyses")}
              collapsed={collapsed}
              external
            />
          ) : null}
        </nav>

        {/* Bottom section */}
        <div className={cn("space-y-4 p-4", collapsed && "px-2")}>
          <button
            type="button"
            onClick={onToggle}
            className="flex size-8 items-center justify-center rounded-lg bg-[var(--sidebar-border)] text-[var(--sidebar-muted)] transition-colors hover:text-[var(--sidebar-fg)]"
          >
            {collapsed ? (
              <ArrowRight className="size-4" />
            ) : (
              <ArrowLeft className="size-4" />
            )}
            <span className="sr-only">Toggle sidebar</span>
          </button>
          <div className={cn("flex", collapsed ? "justify-center" : "px-0")}>
            <ThemeToggle className="text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-account-bg)] hover:text-[var(--sidebar-fg)]" />
          </div>
          <NavUser username={username} collapsed={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
