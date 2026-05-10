import { getTranslations } from "next-intl/server";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import {
  TriageShell,
  type TriageShellLabels,
  type TriageShellState,
} from "@/components/triage/triage-shell";
import {
  type EffectiveCustomerScope,
  getEffectiveCustomerScope,
} from "@/lib/auth/customer-scope";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import { ReviewForbiddenError } from "@/lib/review/errors";
import {
  parseTriagePeriod,
  TRIAGE_HARD_EVENT_CAP,
  TriageForbiddenError,
  TriageUnauthorizedError,
} from "@/lib/triage";
import { PIVOT_DIMENSIONS, type PivotDimensionId } from "@/lib/triage/pivot";
import { loadTriagePeriod } from "@/lib/triage/server-actions";

interface TriagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function pivotDimensionsMap(
  resolver: (id: PivotDimensionId) => string,
): Record<PivotDimensionId, string> {
  const out = {} as Record<PivotDimensionId, string>;
  for (const dim of PIVOT_DIMENSIONS) {
    out[dim.id] = resolver(dim.id);
  }
  return out;
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
    scopeToggle: {
      legend: t("scopeToggle.legend"),
      tier1: t("scopeToggle.tier1"),
      tier2: t("scopeToggle.tier2"),
      tier1Hint: t("scopeToggle.tier1Hint"),
      tier2Hint: t("scopeToggle.tier2Hint"),
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
        pivotFocusTitle: t("assetDetail.pivotFocusTitle"),
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
      pivotPanel: {
        title: t("pivotPanel.title"),
        empty: t("pivotPanel.empty"),
        truncatedHint: (t.raw("pivotPanel.truncatedHint") as string).replace(
          "{cap}",
          new Intl.NumberFormat().format(TRIAGE_HARD_EVENT_CAP),
        ),
        noFocusHint: t("pivotPanel.noFocusHint"),
        showMore: t("pivotPanel.showMore"),
        showLess: t("pivotPanel.showLess"),
        showingOfTemplate: t.raw("pivotPanel.showingOfTemplate") as string,
        pivotActionTemplate: t.raw("pivotPanel.pivotActionTemplate") as string,
        focusValuesTemplate: t.raw("pivotPanel.focusValuesTemplate") as string,
        timeColumn: t("pivotPanel.timeColumn"),
        kindColumn: t("pivotPanel.kindColumn"),
        scoreColumn: t("pivotPanel.scoreColumn"),
        pivotColumn: t("pivotPanel.pivotColumn"),
        family: {
          network: t("pivotPanel.family.network"),
          application: t("pivotPanel.family.application"),
          tls: t("pivotPanel.family.tls"),
          dns: t("pivotPanel.family.dns"),
          "time-structure": t("pivotPanel.family.time-structure"),
        },
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotPanel.dimensions.${id}`),
        ),
        weakSignal: {
          badge: t("tier2.weakBadge"),
          hint: t("tier2.weakBadgeHint"),
        },
      },
      pivotBreadcrumb: {
        ariaLabel: t("pivotBreadcrumb.ariaLabel"),
        rootCrumbPrefix: t("pivotBreadcrumb.rootCrumbPrefix"),
        dimensionCrumbTemplate: t.raw(
          "pivotBreadcrumb.dimensionCrumbTemplate",
        ) as string,
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotBreadcrumb.dimensions.${id}`),
        ),
      },
      tier2Modal: {
        title: t("tier2.prefetchModal.title"),
        descriptionTemplate: t.raw(
          "tier2.prefetchModal.descriptionTemplate",
        ) as string,
        descriptionUnknown: t("tier2.prefetchModal.descriptionUnknown"),
        confirm: t("tier2.prefetchModal.confirm"),
        cancel: t("tier2.prefetchModal.cancel"),
      },
      tier2Eviction: {
        template: t.raw("tier2.evictionTemplate") as string,
        dismiss: t("tier2.evictionDismiss"),
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotPanel.dimensions.${id}`),
        ),
      },
      tier2Error: {
        template: t.raw("tier2.errorTemplate") as string,
        fallbackMessage: t("tier2.errorFallbackMessage"),
        dismiss: t("tier2.errorDismiss"),
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotPanel.dimensions.${id}`),
        ),
      },
      staleHashFallback: t("staleHashFallback"),
    },
    periodChangeConfirm: {
      title: t("periodChangeConfirm.title"),
      description: t("periodChangeConfirm.description"),
      confirm: t("periodChangeConfirm.confirm"),
      cancel: t("periodChangeConfirm.cancel"),
    },
  };

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <TriageShell
        initialPeriod={period}
        initialState={initialState}
        initialClamped={clamped}
        customerScope={cacheKeyForCustomerScope(scope)}
        labels={labels}
      />
    </>
  );
}

/**
 * Stable per-tenant string used as part of the Tier 2 cache key so a
 * cached Tier 2 result for one customer set is not reused after the
 * operator switches to a different customer in the same browser
 * session. Admin-with-no-restriction is its own bucket; assigned
 * scopes are sorted-and-joined customer ids; an empty scope shares the
 * `none` bucket (it never reaches the cache because Tier 2 fetches
 * abort on empty scope at the dispatch context).
 */
function cacheKeyForCustomerScope(scope: EffectiveCustomerScope): string {
  if (scope.kind === "admin" && scope.customers.length === 0) return "admin";
  if (scope.customers.length === 0) return "none";
  const ids = [...scope.customers.map((c) => c.id)].sort((a, b) => a - b);
  return `${scope.kind}:${ids.join(",")}`;
}
