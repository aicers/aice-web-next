"use client";

import { useState } from "react";

import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { CustomerScopeIndicator } from "@/components/layout/customer-scope-indicator";
import { MobileHeader } from "@/components/layout/mobile-header";
import { Sidebar } from "@/components/layout/sidebar";
import { TimezoneProvider } from "@/components/providers/timezone-provider";
import { useSidebar } from "@/hooks/use-sidebar";
import type { EffectiveCustomerScope } from "@/lib/auth/customer-scope";

interface DashboardLayoutProps {
  children: React.ReactNode;
  username?: string;
  scope: EffectiveCustomerScope;
  canManageCustomers: boolean;
  initialSidebarCollapsed?: boolean;
  hasSidebarCollapsedCookie?: boolean;
}

export default function DashboardLayout({
  children,
  username,
  scope,
  canManageCustomers,
  initialSidebarCollapsed = false,
  hasSidebarCollapsedCookie = false,
}: Readonly<DashboardLayoutProps>) {
  const { collapsed, toggle } = useSidebar({
    initialCollapsed: initialSidebarCollapsed,
    hasCookie: hasSidebarCollapsedCookie,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TimezoneProvider>
      <div className="flex h-screen flex-col">
        {/* Mobile header — visible only below desktop breakpoint */}
        <MobileHeader
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          username={username}
          scope={scope}
          canManageCustomers={canManageCustomers}
        />

        <div className="flex flex-1 overflow-hidden">
          {/* Desktop sidebar — hidden below desktop breakpoint */}
          <div className="hidden desktop:flex">
            <Sidebar
              collapsed={collapsed}
              onToggle={toggle}
              username={username}
            />
          </div>

          {/* Main content */}
          <main className="flex flex-1 flex-col overflow-hidden">
            {/* Breadcrumb bar */}
            <div className="flex h-16 shrink-0 items-center justify-between gap-3 px-6">
              <Breadcrumbs />
              <CustomerScopeIndicator
                scope={scope}
                canManage={canManageCustomers}
                className="hidden desktop:inline-flex"
              />
            </div>

            {/* Page content */}
            <div className="flex-1 overflow-y-auto p-6">{children}</div>
          </main>
        </div>
      </div>
    </TimezoneProvider>
  );
}
