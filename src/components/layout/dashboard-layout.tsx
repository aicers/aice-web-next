"use client";

import { useState } from "react";

import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { MobileHeader } from "@/components/layout/mobile-header";
import { Sidebar } from "@/components/layout/sidebar";
import { TimezoneProvider } from "@/components/providers/timezone-provider";
import { useSidebar } from "@/hooks/use-sidebar";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { collapsed, toggle } = useSidebar();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TimezoneProvider>
      <div className="flex h-screen flex-col">
        {/* Mobile header — visible only below desktop breakpoint */}
        <MobileHeader open={mobileOpen} onOpenChange={setMobileOpen} />

        <div className="flex flex-1 overflow-hidden">
          {/* Desktop sidebar — hidden below desktop breakpoint */}
          <div className="hidden desktop:flex">
            <Sidebar collapsed={collapsed} onToggle={toggle} />
          </div>

          {/* Main content */}
          <main className="flex flex-1 flex-col overflow-hidden">
            {/* Breadcrumb bar */}
            <div className="flex h-16 shrink-0 items-center border-b px-6">
              <Breadcrumbs />
            </div>

            {/* Page content */}
            <div className="flex-1 overflow-y-auto p-6">{children}</div>
          </main>
        </div>
      </div>
    </TimezoneProvider>
  );
}
