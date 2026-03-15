"use client";

import {
  FileText,
  Home,
  LayoutDashboard,
  Menu,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePathname } from "@/i18n/navigation";
import { ThemeToggle } from "../theme-toggle";
import { Logo } from "./logo";
import { NavUser } from "./nav-user";
import { SidebarItem } from "./sidebar-item";

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

interface MobileHeaderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username?: string;
}

export function MobileHeader({
  open,
  onOpenChange,
  username,
}: MobileHeaderProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <>
      <header className="flex h-14 items-center border-b bg-[var(--sidebar-bg)] px-4 desktop:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onOpenChange(true)}
          className="text-[var(--sidebar-fg)] hover:bg-[var(--sidebar-border)]"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
        <Logo className="ml-3" />
      </header>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          className="w-64 border-none bg-[var(--sidebar-bg)] p-0 text-[var(--sidebar-fg)]"
        >
          <SheetHeader className="px-5 pt-6">
            <SheetTitle className="text-[var(--sidebar-fg)]">
              <Logo />
            </SheetTitle>
          </SheetHeader>

          {/* Divider */}
          <div className="px-4 pt-6">
            <div className="h-px bg-[var(--sidebar-border)]" />
          </div>

          <TooltipProvider>
            <nav className="flex-1 space-y-3 overflow-y-auto pt-6">
              {NAV_ITEMS.map((item) => (
                <SidebarItem
                  key={item.key}
                  href={item.href}
                  icon={item.icon}
                  label={t(item.key)}
                  active={pathname.startsWith(item.href)}
                />
              ))}
            </nav>
            <div className="space-y-4 p-4">
              <div className="px-0">
                <ThemeToggle className="text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-border)] hover:text-[var(--sidebar-fg)]" />
              </div>
              <NavUser username={username} />
            </div>
          </TooltipProvider>
        </SheetContent>
      </Sheet>
    </>
  );
}
