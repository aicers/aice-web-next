import { getTranslations } from "next-intl/server";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import {
  TriageShell,
  type TriageShellLabels,
  type TriageShellState,
} from "@/components/triage/triage-shell";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import { ReviewForbiddenError } from "@/lib/review/errors";
import {
  parseTriagePeriod,
  TriageForbiddenError,
  TriageUnauthorizedError,
} from "@/lib/triage";
import { loadTriagePeriod } from "@/lib/triage/server-actions";

interface TriagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TriagePage({ searchParams }: TriagePageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "triage:read");

  const t = await getTranslations("triage");
  const scope = await getEffectiveCustomerScope(session);
  const rawParams = await searchParams;

  const rawStart = typeof rawParams.start === "string" ? rawParams.start : null;
  const rawEnd = typeof rawParams.end === "string" ? rawParams.end : null;
  const { period, clamped } = parseTriagePeriod(rawStart, rawEnd);

  let initialState: TriageShellState;
  try {
    const result = await loadTriagePeriod(session, period);
    initialState = { status: "ok", result };
  } catch (err) {
    // An unrecognised review GraphQL error is surfaced as the generic
    // banner rather than re-thrown — Triage is read-only and the
    // operator can pick a different period to recover.
    if (err instanceof TriageUnauthorizedError) {
      // Defense in depth — the page-level `requirePermission` should
      // already have redirected, but if it ever doesn't, classify the
      // raised gate as a permission failure instead of an unknown one.
      initialState = { status: "error", kind: "forbidden" };
    } else if (
      err instanceof TriageForbiddenError ||
      err instanceof ReviewForbiddenError
    ) {
      initialState = { status: "error", kind: "forbidden-scope" };
    } else {
      initialState = { status: "error", kind: "unknown" };
    }
  }

  const labels: TriageShellLabels = {
    title: t("title"),
    intro: t("intro"),
    errorBanner: t("errorBanner"),
    forbiddenBanner: t("forbiddenBanner"),
    forbiddenScopeBanner: t("forbiddenScopeBanner"),
    truncatedBannerTemplate: t.raw("truncatedBannerTemplate") as string,
    clampedNotice: t("clampedNotice"),
    periodPicker: {
      legend: t("periodPicker.legend"),
      startLabel: t("periodPicker.startLabel"),
      endLabel: t("periodPicker.endLabel"),
      apply: t("periodPicker.apply"),
      invalidRange: t("periodPicker.invalidRange"),
      durationCapHint: t("periodPicker.durationCapHint"),
      lookbackHint: t("periodPicker.lookbackHint"),
    },
    modeToggle: {
      legend: t("modeToggle.legend"),
      baseline: t("modeToggle.baseline"),
      policies: t("modeToggle.policies"),
      policiesUnavailable: t("modeToggle.policiesUnavailable"),
    },
    baseline: {
      funnel: {
        title: t("funnel.title"),
        detected: t("funnel.detected"),
        triaged: t("funnel.triaged"),
        passThrough: t("funnel.passThrough"),
        passThroughHint: t("funnel.passThroughHint"),
      },
      assetList: {
        title: t("assetList.title"),
        empty: t("assetList.empty"),
        addressColumn: t("assetList.addressColumn"),
        scoreColumn: t("assetList.scoreColumn"),
        triagedColumn: t("assetList.triagedColumn"),
        detectedColumn: t("assetList.detectedColumn"),
        rowDetailsTemplate: t.raw("assetList.rowDetailsTemplate") as string,
      },
      assetDetail: {
        title: t("assetDetail.title"),
        emptySelection: t("assetDetail.emptySelection"),
        emptyEvents: t("assetDetail.emptyEvents"),
        scoreLabel: t("assetDetail.scoreLabel"),
        triagedLabel: t("assetDetail.triagedLabel"),
        detectedLabel: t("assetDetail.detectedLabel"),
        eventsHeading: t("assetDetail.eventsHeading"),
        timeColumn: t("assetDetail.timeColumn"),
        kindColumn: t("assetDetail.kindColumn"),
        categoryColumn: t("assetDetail.categoryColumn"),
        scoreColumn: t("assetDetail.scoreColumn"),
      },
    },
  };

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <TriageShell
        initialPeriod={period}
        initialState={initialState}
        initialClamped={clamped}
        labels={labels}
      />
    </>
  );
}
