"use client";

import { useState } from "react";

import { AimerPhase2Banner } from "@/components/layout/aimer-phase2-banner";
import { AimerPhase2CadenceManager } from "@/components/layout/aimer-phase2-cadence-manager";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { CustomerScopeIndicator } from "@/components/layout/customer-scope-indicator";
import { MobileHeader } from "@/components/layout/mobile-header";
import { Sidebar } from "@/components/layout/sidebar";
import { ScopeFingerprintProvider } from "@/components/providers/scope-fingerprint-provider";
import { TimezoneProvider } from "@/components/providers/timezone-provider";
import { useSidebar } from "@/hooks/use-sidebar";
import type { EffectiveCustomerScope } from "@/lib/auth/customer-scope";

interface DashboardLayoutProps {
  children: React.ReactNode;
  username?: string;
  scope: EffectiveCustomerScope;
  /**
   * Stable hash of `(accountId, sorted(customerIds))` injected from
   * the server layout. Threaded through {@link ScopeFingerprintProvider}
   * so every client-side cache owner under the dashboard reads the
   * same value without re-deriving it (#393 Task A).
   */
  scopeFingerprint: string;
  canManageCustomers: boolean;
  initialSidebarCollapsed?: boolean;
  /**
   * When `true`, mount the Phase 2 sync banner (#620). The banner is
   * gated on System Administrator because the underlying
   * `/api/aimer/phase2/status/summary` route uses the same gate; a
   * non-admin session would only see a 403 on the banner's fetch.
   */
  isAimerSystemAdmin?: boolean;
  /**
   * Absolute aimer-web `/analysis` URL composed server-side from the
   * integration bridge URL, or `null` when the integration is
   * unconfigured. Threaded to the nav so the "Open AI analyses" link is
   * fed from the server and hidden when there is no bridge URL (#646).
   */
  aimerAnalysisHref?: string | null;
}

export default function DashboardLayout({
  children,
  username,
  scope,
  scopeFingerprint,
  canManageCustomers,
  initialSidebarCollapsed = false,
  isAimerSystemAdmin = false,
  aimerAnalysisHref = null,
}: Readonly<DashboardLayoutProps>) {
  const { collapsed, toggle } = useSidebar({
    initialCollapsed: initialSidebarCollapsed,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <ScopeFingerprintProvider fingerprint={scopeFingerprint}>
      <TimezoneProvider>
        <div className="flex h-screen flex-col">
          {isAimerSystemAdmin && <AimerPhase2Banner />}
          {/*
           * App-shell Phase 2 push cadence (#651). Mounted once, here, so
           * the per-customer opportunistic drain runs "while signed in"
           * rather than only while a Triage screen is open. Renders
           * nothing; gated to System Administrators like the banner.
           */}
          {isAimerSystemAdmin && (
            <AimerPhase2CadenceManager
              customerIds={scope.customers.map((c) => c.id)}
            />
          )}

          {/* Mobile header — visible only below desktop breakpoint */}
          <MobileHeader
            open={mobileOpen}
            onOpenChange={setMobileOpen}
            username={username}
            scope={scope}
            canManageCustomers={canManageCustomers}
            aimerAnalysisHref={aimerAnalysisHref}
          />

          <div className="flex flex-1 overflow-hidden">
            {/* Desktop sidebar — hidden below desktop breakpoint */}
            <div className="hidden desktop:flex">
              <Sidebar
                collapsed={collapsed}
                onToggle={toggle}
                username={username}
                aimerAnalysisHref={aimerAnalysisHref}
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
    </ScopeFingerprintProvider>
  );
}
