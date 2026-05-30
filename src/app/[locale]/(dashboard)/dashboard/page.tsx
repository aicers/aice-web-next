import { getTranslations } from "next-intl/server";

import { DashboardAiAnalysisCards } from "@/components/dashboard/ai-analysis-cards";
import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "dashboard:read");

  const t = await getTranslations("dashboard");
  const scope = await getEffectiveCustomerScope(session);

  // The effective scope is fully enumerated (all customers for admins),
  // so the LIVE / DAILY cards fan out over `scope.customers`. The cards
  // require `triage:read` at the route layer; a `dashboard:read`-only
  // viewer simply sees no cards (the routes 403 → "no card").
  const aiAnalysisLabels = {
    sectionHeading: t("aiAnalysis.sectionHeading"),
    latestDigestTitle: t("aiAnalysis.latestDigestTitle"),
    todayReportTitle: t("aiAnalysis.todayReportTitle"),
    badge: {
      tierCritical: t("aiAnalysis.badge.tierCritical"),
      tierHigh: t("aiAnalysis.badge.tierHigh"),
      tooltipTemplate: t.raw("aiAnalysis.badge.tooltipTemplate") as string,
      linkAriaLabel: t.raw("aiAnalysis.badge.linkAriaLabel") as string,
    },
  };

  return (
    <div className="space-y-6">
      <CustomerScopeCallout scope={scope} />
      <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
      <DashboardAiAnalysisCards
        customers={scope.customers}
        labels={aiAnalysisLabels}
      />
      <p className="text-muted-foreground">{t("placeholder")}</p>
    </div>
  );
}
