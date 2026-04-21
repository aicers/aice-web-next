import { getTranslations } from "next-intl/server";

import { DetectionShell } from "@/components/detection/detection-shell";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";

export default async function DetectionPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "detection:read");

  const t = await getTranslations("detection");

  return (
    <DetectionShell
      title={t("title")}
      labels={{
        recommendedFilter: t("savedRail.recommended"),
        savedFilters: t("savedRail.saved"),
        railPlaceholder: t("savedRail.placeholder"),
        filtersOpen: t("filters.open"),
        filtersComingSoon: t("filters.comingSoon"),
        activeChips: t("filters.activeChips"),
        resultsPlaceholder: t("results.placeholder"),
        analyticsToggle: t("analytics.toggle"),
        analyticsShow: t("analytics.show"),
        analyticsHide: t("analytics.hide"),
        analyticsPlaceholder: t("analytics.placeholder"),
      }}
    />
  );
}
