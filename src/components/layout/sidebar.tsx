"use client";

import {
  ChevronLeft,
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

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "bg-card flex h-full flex-col border-r transition-[width] duration-200",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Logo / Header */}
        <div
          className={cn(
            "flex h-16 items-center border-b px-4",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {collapsed ? (
            <button
              type="button"
              onClick={onToggle}
              className="flex items-center justify-center"
            >
              <Logo collapsed />
              <span className="sr-only">Toggle sidebar</span>
            </button>
          ) : (
            <>
              <Logo />
              <Button variant="ghost" size="icon" onClick={onToggle}>
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Toggle sidebar</span>
              </Button>
            </>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
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
        <div className="space-y-1 p-2">
          <Separator className="mb-2" />
          <div className={cn("flex", collapsed ? "justify-center" : "px-1")}>
            <ThemeToggle />
          </div>
          <NavUser collapsed={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
