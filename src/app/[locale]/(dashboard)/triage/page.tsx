import { getTranslations } from "next-intl/server";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import {
  TriageShell,
  type TriageShellLabels,
  type TriageShellState,
} from "@/components/triage/triage-shell";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import {
  type EffectiveCustomerScope,
  getEffectiveCustomerScope,
} from "@/lib/auth/customer-scope";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import { ReviewForbiddenError } from "@/lib/review/errors";
import {
  parseStrictnessStopId,
  parseTriagePeriod,
  TRIAGE_HARD_EVENT_CAP,
  TriageForbiddenError,
  TriageUnauthorizedError,
} from "@/lib/triage";
import { PIVOT_DIMENSIONS, type PivotDimensionId } from "@/lib/triage/pivot";
import { loadTriagePeriod } from "@/lib/triage/server-actions";
import { loadStoriesForPeriod } from "@/lib/triage/story/actions";
import type { TriageStory } from "@/lib/triage/story/types";

interface TriagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Static-options Tier-2-only dimension ids that have no entry in
// {@link PIVOT_DIMENSIONS}; the panel renders them through dedicated
// section paths but they still need labels in the dimensions map for
// breadcrumb / pivot-focus rendering.
const STATIC_DIMENSION_IDS: readonly PivotDimensionId[] = [
  "learningMethods",
  "keywords",
];

function pivotDimensionsMap(
  resolver: (id: PivotDimensionId) => string,
): Record<PivotDimensionId, string> {
  const out = {} as Record<PivotDimensionId, string>;
  for (const dim of PIVOT_DIMENSIONS) {
    out[dim.id] = resolver(dim.id);
  }
  for (const id of STATIC_DIMENSION_IDS) {
    out[id] = resolver(id);
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
  const rawStrictness =
    typeof rawParams.strictness === "string" ? rawParams.strictness : null;
  const strictness = parseStrictnessStopId(rawStrictness);

  let initialState: TriageShellState;
  let stories: TriageStory[] = [];
  let storiesTruncated = false;
  try {
    const result = await loadTriagePeriod(session, period, { strictness });
    initialState = { status: "ok", result };
    // Stories load runs in parallel with the rest of the page only
    // when the asset-list read succeeded; if `triage:read` was denied
    // there is no point fanning out a second query.
    try {
      const s = await loadStoriesForPeriod(session, period);
      stories = s.stories;
      storiesTruncated = s.truncated;
    } catch {
      // Stories failure must not block the rest of the menu — the tab
      // simply renders empty if the read path errors. This keeps the
      // ship deployable when the Story schema migration has not yet
      // landed on a particular tenant.
      stories = [];
      storiesTruncated = false;
    }
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
    storyProtectedTruncatedBannerTemplate: t.raw(
      "storyProtectedTruncatedBannerTemplate",
    ) as string,
    clampedNotice: t("clampedNotice"),
    observedDenominatorTruncatedNotice: t("observedDenominatorTruncatedNotice"),
    freshness: {
      okTemplate: t.raw("freshness.okTemplate") as string,
      runningWithPreviousTemplate: t.raw(
        "freshness.runningWithPreviousTemplate",
      ) as string,
      runningFirstIngest: t("freshness.runningFirstIngest"),
      failedTemplate: t.raw("freshness.failedTemplate") as string,
      failedFirstIngest: t("freshness.failedFirstIngest"),
      awaitingFirstIngest: t("freshness.awaitingFirstIngest"),
      okMultiTemplate: t.raw("freshness.okMultiTemplate") as string,
      affectedCustomersHeading: t("freshness.affectedCustomersHeading"),
      relative: {
        justNow: t("freshness.relative.justNow"),
        minutesTemplate: t.raw("freshness.relative.minutesTemplate") as string,
        hoursTemplate: t.raw("freshness.relative.hoursTemplate") as string,
        daysTemplate: t.raw("freshness.relative.daysTemplate") as string,
      },
    },
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
    strictnessSlider: {
      legend: t("strictnessSlider.legend"),
      hint: t("strictnessSlider.hint"),
      allStopHint: t("strictnessSlider.allStopHint"),
      eligibleHintTemplate: t.raw(
        "strictnessSlider.eligibleHintTemplate",
      ) as string,
      stops: {
        all: t("strictnessSlider.stops.all"),
        top80: t("strictnessSlider.stops.top80"),
        top50: t("strictnessSlider.stops.top50"),
        top20: t("strictnessSlider.stops.top20"),
        top5: t("strictnessSlider.stops.top5"),
      },
    },
    baseline: {
      funnel: {
        title: t("funnel.title"),
        detected: t("funnel.detected"),
        triaged: t("funnel.triaged"),
        triagedHint: t("funnel.triagedHint"),
        shown: t("funnel.shown"),
        shownHint: t("funnel.shownHint"),
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
        detectedOver30dHint: t("assetList.detectedOver30dHint"),
        rowDetailsTemplate: t.raw("assetList.rowDetailsTemplate") as string,
      },
      assetDetail: {
        title: t("assetDetail.title"),
        pivotFocusTitle: t("assetDetail.pivotFocusTitle"),
        customerLabel: t("assetDetail.customerLabel"),
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
        protectedByStoryMarker: {
          template: t.raw(
            "assetDetail.protectedByStoryMarkerTemplate",
          ) as string,
        },
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
        protectedByStoryMarker: {
          template: t.raw(
            "assetDetail.protectedByStoryMarkerTemplate",
          ) as string,
        },
        family: {
          network: t("pivotPanel.family.network"),
          application: t("pivotPanel.family.application"),
          tls: t("pivotPanel.family.tls"),
          dns: t("pivotPanel.family.dns"),
          "time-structure": t("pivotPanel.family.time-structure"),
          "tier2-only": t("pivotPanel.family.tier2-only"),
        },
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotPanel.dimensions.${id}`),
        ),
        weakSignal: {
          badge: t("tier2.weakBadge"),
          hint: t("tier2.weakBadgeHint"),
        },
        learningMethodValues: {
          UNSUPERVISED: t("pivotPanel.values.learningMethod.UNSUPERVISED"),
          SEMI_SUPERVISED: t(
            "pivotPanel.values.learningMethod.SEMI_SUPERVISED",
          ),
        },
        keywords: {
          hint: t("pivotPanel.keywords.hint"),
          inputLabel: t("pivotPanel.keywords.inputLabel"),
          inputPlaceholder: t("pivotPanel.keywords.inputPlaceholder"),
          submit: t("pivotPanel.keywords.submit"),
          recentHeading: t("pivotPanel.keywords.recentHeading"),
          recentChipTemplate: t.raw(
            "pivotPanel.keywords.recentChipTemplate",
          ) as string,
          errorEmpty: t("pivotPanel.keywords.errorEmpty"),
          errorTooLongTemplate: t.raw(
            "pivotPanel.keywords.errorTooLongTemplate",
          ) as string,
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
        storyOriginTemplate: t.raw(
          "pivotBreadcrumb.storyOriginTemplate",
        ) as string,
      },
      tier2Modal: {
        title: t("tier2.prefetchModal.title"),
        descriptionTemplate: t.raw(
          "tier2.prefetchModal.descriptionTemplate",
        ) as string,
        descriptionApproximateTemplate: t.raw(
          "tier2.prefetchModal.descriptionApproximateTemplate",
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
      tier2Progress: {
        progress: t("tier2.fetchProgress"),
        progressTemplate: t.raw("tier2.fetchProgressTemplate") as string,
        dimensions: pivotDimensionsMap((id) =>
          t(`pivotPanel.dimensions.${id}`),
        ),
      },
      staleHashFallback: t("staleHashFallback"),
      sensorScopeForbiddenFallback: t("sensorScopeForbiddenFallback"),
      tabStrip: {
        legend: t("tabStrip.legend"),
        assetList: t("tabStrip.assetList"),
        stories: t("tabStrip.stories"),
        pivot: t("tabStrip.pivot"),
      },
      stories: {
        heading: t("stories.heading"),
        empty: t("stories.empty"),
        truncatedTemplate: t.raw("stories.truncatedTemplate") as string,
        emptyUnsentOnly: t("stories.emptyUnsentOnly"),
        showOnlyUnsentLabel: t("stories.showOnlyUnsentLabel"),
        sortLabel: t("stories.sortLabel"),
        sortByTimeWindowEnd: t("stories.sortByTimeWindowEnd"),
        sortByScore: t("stories.sortByScore"),
        staleHashFallback: t("stories.staleHashFallback"),
        card: {
          ruleBadgeAuto: t("stories.card.ruleBadgeAuto"),
          ruleBadgeAnalyst: t("stories.card.ruleBadgeAnalyst"),
          scoreLabel: t("stories.card.scoreLabel"),
          memberCountTemplate: t.raw(
            "stories.card.memberCountTemplate",
          ) as string,
          open: t("stories.card.open"),
          sendToAimerWeb: t("stories.card.sendToAimerWeb"),
          sendToAimerWebTooltip: t("stories.card.sendToAimerWebTooltip"),
          sendMoreMenuLabel: t("stories.card.sendMoreMenuLabel"),
          sendForceRefresh: t("stories.card.sendForceRefresh"),
          forceRefreshConfirmMessage: t(
            "stories.card.forceRefreshConfirmMessage",
          ),
          forceRefreshConfirmButton: t(
            "stories.card.forceRefreshConfirmButton",
          ),
          forceRefreshCancelButton: t("stories.card.forceRefreshCancelButton"),
          sendInFlight: t("stories.card.sendInFlight"),
          sendSuccessToast: t("stories.card.sendSuccessToast"),
          sendErrorPrefix: t("stories.card.sendErrorPrefix"),
          sentIndicatorTemplate: t.raw(
            "stories.card.sentIndicatorTemplate",
          ) as string,
          sentMultiTemplate: t.raw("stories.card.sentMultiTemplate") as string,
          timeColumn: t("stories.card.timeColumn"),
          kindColumn: t("stories.card.kindColumn"),
          categoryColumn: t("stories.card.categoryColumn"),
          topMembersHeading: t("stories.card.topMembersHeading"),
          relative: {
            justNow: t("stories.card.relative.justNow"),
            secondsTemplate: t.raw(
              "stories.card.relative.secondsTemplate",
            ) as string,
            minutesTemplate: t.raw(
              "stories.card.relative.minutesTemplate",
            ) as string,
            hoursTemplate: t.raw(
              "stories.card.relative.hoursTemplate",
            ) as string,
            daysTemplate: t.raw("stories.card.relative.daysTemplate") as string,
          },
          duration: {
            lessThanMinute: t("stories.card.duration.lessThanMinute"),
            minutesTemplate: t.raw(
              "stories.card.duration.minutesTemplate",
            ) as string,
            hoursTemplate: t.raw(
              "stories.card.duration.hoursTemplate",
            ) as string,
            hoursMinutesTemplate: t.raw(
              "stories.card.duration.hoursMinutesTemplate",
            ) as string,
          },
        },
        detail: {
          heading: t("stories.detail.heading"),
          emptySelection: t("stories.detail.emptySelection"),
          emptyMembers: t("stories.detail.emptyMembers"),
          customerLabel: t("stories.detail.customerLabel"),
          scoreLabel: t("stories.detail.scoreLabel"),
          ruleLabel: t("stories.detail.ruleLabel"),
          danglingNoticeTemplate: t.raw(
            "stories.detail.danglingNoticeTemplate",
          ) as string,
          timeColumn: t("stories.detail.timeColumn"),
          kindColumn: t("stories.detail.kindColumn"),
          categoryColumn: t("stories.detail.categoryColumn"),
          origAddrColumn: t("stories.detail.origAddrColumn"),
          respAddrColumn: t("stories.detail.respAddrColumn"),
          scoreColumn: t("stories.detail.scoreColumn"),
          loading: t("stories.detail.loading"),
          close: t("stories.detail.close"),
          pivotActionsColumn: t("stories.detail.pivotActionsColumn"),
          pivotActionTemplate: t.raw(
            "stories.detail.pivotActionTemplate",
          ) as string,
          pivotDimensions: pivotDimensionsMap((id) =>
            t(`pivotBreadcrumb.dimensions.${id}`),
          ),
          // Reuses the asset-detail copy (#471 §3): the marker glyph
          // and accessible label are identical across per-event
          // surfaces — a single shared template keeps EN/KR parity
          // automatic and avoids drift between surfaces.
          protectedByStoryMarker: {
            template: t.raw(
              "assetDetail.protectedByStoryMarkerTemplate",
            ) as string,
          },
        },
      },
      saveAsStory: {
        button: t("saveAsStory.button"),
        disabledMultiCustomer: t("saveAsStory.disabledMultiCustomer"),
        modalTitle: t("saveAsStory.modalTitle"),
        titleLabel: t("saveAsStory.titleLabel"),
        titlePlaceholder: t("saveAsStory.titlePlaceholder"),
        membersHeading: t("saveAsStory.membersHeading"),
        confirm: t("saveAsStory.confirm"),
        cancel: t("saveAsStory.cancel"),
        successToast: t("saveAsStory.successToast"),
        errorOverCap: t("saveAsStory.errorOverCap"),
        errorEmpty: t("saveAsStory.errorEmpty"),
        errorMemberNotFound: t("saveAsStory.errorMemberNotFound"),
        errorAssetMismatch: t("saveAsStory.errorAssetMismatch"),
        errorCustomerOutOfScope: t("saveAsStory.errorCustomerOutOfScope"),
        errorMultiCustomer: t("saveAsStory.errorMultiCustomer"),
        errorGeneric: t("saveAsStory.errorGeneric"),
      },
    },
    periodChangeConfirm: {
      title: t("periodChangeConfirm.title"),
      description: t("periodChangeConfirm.description"),
      confirm: t("periodChangeConfirm.confirm"),
      cancel: t("periodChangeConfirm.cancel"),
    },
  };

  // Admin rebuild affordance (#473). Visible to System Administrators
  // only; the button itself further hides when scope spans 2+
  // customers. The page resolves the role+scope server-side so the
  // client never has to guess.
  const showRebuildAffordance = isSystemAdministrator(session.roles);
  if (showRebuildAffordance) {
    labels.rebuild = {
      button: t("rebuild.button"),
      multiScopeTooltip: t("rebuild.multiScopeTooltip"),
      modalTitle: t("rebuild.modalTitle"),
      modalIntro: t("rebuild.modalIntro"),
      customerLabel: t("rebuild.customerLabel"),
      periodLabel: t("rebuild.periodLabel"),
      whatThisDoesLabel: t("rebuild.whatThisDoesLabel"),
      whatThisDoesBody: t("rebuild.whatThisDoesBody"),
      estimateLabel: t("rebuild.estimateLabel"),
      estimateHint: t("rebuild.estimateHint"),
      abortNote: t("rebuild.abortNote"),
      confirmButton: t("rebuild.confirmButton"),
      cancelButton: t("rebuild.cancelButton"),
      toastSuccessTemplate: t.raw("rebuild.toastSuccessTemplate") as string,
      toastBusy: t("rebuild.toastBusy"),
      toastTimeout: t("rebuild.toastTimeout"),
      toastIncomplete: t("rebuild.toastIncomplete"),
      toastErrorPrefix: t("rebuild.toastErrorPrefix"),
      rebuildingOverlay: t("rebuild.rebuildingOverlay"),
    };
  }
  const rebuildProps = showRebuildAffordance
    ? {
        customer:
          scope.customers.length === 1
            ? {
                id: scope.customers[0].id,
                name: scope.customers[0].name,
              }
            : null,
        multiCustomerScope: scope.customers.length > 1,
      }
    : undefined;

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <TriageShell
        initialPeriod={period}
        initialState={initialState}
        initialClamped={clamped}
        initialStrictness={strictness}
        customerScope={cacheKeyForCustomerScope(scope)}
        initialStories={stories}
        initialStoriesTruncated={storiesTruncated}
        inScopeCustomerIds={scope.customers.map((c) => c.id)}
        rebuild={rebuildProps}
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
