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
import { Separator } from "@/components/ui/separator";
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
}

export function MobileHeader({ open, onOpenChange }: MobileHeaderProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <>
      <header className="bg-card flex h-14 items-center border-b px-4 desktop:hidden">
        <Button variant="ghost" size="icon" onClick={() => onOpenChange(true)}>
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
        <Logo className="ml-3" />
      </header>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="border-b px-4">
            <SheetTitle>
              <Logo />
            </SheetTitle>
          </SheetHeader>
          <TooltipProvider>
            <nav className="flex-1 space-y-1 overflow-y-auto p-2">
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
            <div className="space-y-1 p-2">
              <Separator className="mb-2" />
              <div className="px-1">
                <ThemeToggle />
              </div>
              <NavUser />
            </div>
          </TooltipProvider>
        </SheetContent>
      </Sheet>
    </>
  );
}
