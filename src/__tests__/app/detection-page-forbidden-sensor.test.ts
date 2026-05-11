import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

// #278: cold loads from a tampered URL run through the SSR
// `searchEventsAtAnchor` path in `page.tsx`, *not* `runEventQuery`,
// so the typed `forbidden-sensor-scope` classification has to apply
// at the page boundary. This test pins the contract that a SSR
// `ReviewForbiddenError` against a filter carrying `sensors=[...]`
// surfaces as the sensor-scope banner (title + ids forwarded to the
// shell), while the same error against a filter with no `sensors`
// still collapses back to the generic forbidden-scope copy.

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockSearchEventsAtAnchor = vi.hoisted(() => vi.fn());
const mockGetTranslations = vi.hoisted(() => vi.fn());
const mockGetLocale = vi.hoisted(() => vi.fn());
const mockDetectionShell = vi.hoisted(() =>
  vi.fn((props: unknown) => {
    capturedShellProps = props;
    return null;
  }),
);

let capturedShellProps: unknown = null;

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
  requirePermission: mockRequirePermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  getEffectiveCustomerScope: vi.fn(async () => ({
    kind: "assigned" as const,
    customers: [{ id: 1, name: "ACME" }],
  })),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: mockGetTranslations,
  getLocale: mockGetLocale,
}));

vi.mock("@/components/detection/detection-shell", () => ({
  DetectionShell: mockDetectionShell,
}));

vi.mock("@/components/layout/customer-scope-callout", () => ({
  CustomerScopeCallout: () => null,
}));

vi.mock("@/lib/detection", async () => {
  const period = await vi.importActual<typeof import("@/lib/detection/period")>(
    "@/lib/detection/period",
  );
  const urlFilters = await vi.importActual<
    typeof import("@/lib/detection/url-filters")
  >("@/lib/detection/url-filters");
  const pagination = await vi.importActual<
    typeof import("@/lib/detection/pagination")
  >("@/lib/detection/pagination");
  const filterUrl = await vi.importActual<
    typeof import("@/lib/detection/filter-url")
  >("@/lib/detection/filter-url");
  // Keep the real classifier — the whole point of the SSR test is to
  // verify it fires on the page's catch branch.
  const eventQueryError = await vi.importActual<
    typeof import("@/lib/detection/event-query-error")
  >("@/lib/detection/event-query-error");
  return {
    ...period,
    ...urlFilters,
    ...pagination,
    ...filterUrl,
    ...eventQueryError,
    searchEventsAtAnchor: mockSearchEventsAtAnchor,
    EVENT_KIND_FRIENDLY_NAMES: {},
  };
});

vi.mock("@/components/events/event-display-helpers", () => ({
  EVENT_KIND_FRIENDLY_NAMES: {},
}));

vi.mock("@/lib/detection/countries", () => ({
  COUNTRY_CODES: ["US", "KR"],
}));

vi.mock("@/lib/detection/direction", () => ({
  FLOW_KINDS: ["INBOUND", "OUTBOUND", "INTERNAL", "EXTERNAL"],
}));

vi.mock("@/lib/detection/filter-options", () => ({
  INITIAL_THREAT_KINDS: ["HttpThreat"],
  LEARNING_METHOD_VALUES: ["UNSUPERVISED", "SEMI_SUPERVISED"],
  THREAT_CATEGORY_KEY_BY_VALUE: {},
  THREAT_CATEGORY_VALUES: [],
  THREAT_LEVEL_VALUES: [],
}));

vi.mock("@/lib/detection/page-size", () => ({
  DEFAULT_EVENT_LIST_PAGE_SIZE: 50,
}));

const validSession: AuthSession = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["Security Monitor"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: 0,
  exp: 0,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "test",
  sessionBrowserFingerprint: "test",
  needsReauth: false,
  sessionCreatedAt: new Date(0),
  sessionLastActiveAt: new Date(0),
};

function translator(key: string): string {
  return key;
}
translator.raw = (key: string) => key;

async function loadPage() {
  return (await import("@/app/[locale]/(dashboard)/detection/page")).default;
}

async function renderPage(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<void> {
  const Page = await loadPage();
  const element = await Page({ searchParams: Promise.resolve(searchParams) });
  renderToStaticMarkup(element);
}

async function buildFilterUrlParam(sensors?: string[]): Promise<string> {
  // Use the production encoder so the payload schema and field
  // coercion match exactly what `parseFilterFromUrlParam` accepts on
  // the other side. A hand-rolled blob diverges from the canonical
  // shape and the parser silently drops everything to defaults, which
  // would mask whether the SSR classification ran at all.
  const { serializeFilterToUrlParam } = await import(
    "@/lib/detection/filter-url"
  );
  return serializeFilterToUrlParam({
    filter: {
      mode: "structured",
      input: sensors ? { sensors } : {},
    },
    period: "1h",
    endpoints: [],
    pivotExtras: {},
  });
}

beforeEach(() => {
  mockGetCurrentSession.mockReset();
  mockRequirePermission.mockReset();
  mockSearchEventsAtAnchor.mockReset();
  mockGetTranslations.mockReset();
  mockGetLocale.mockReset();
  mockDetectionShell.mockClear();
  capturedShellProps = null;
  mockGetCurrentSession.mockResolvedValue(validSession);
  mockRequirePermission.mockResolvedValue(undefined);
  mockGetTranslations.mockResolvedValue(translator);
  mockGetLocale.mockResolvedValue("en");
  vi.resetModules();
});

describe("DetectionPage SSR forbidden-sensor-scope classification (#278)", () => {
  it("threads `unavailableSensorIds` and the sensor-banner title into the bootstrap tab when the SSR dispatch fails with sensors in the filter", async () => {
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockSearchEventsAtAnchor.mockRejectedValue(
      new ReviewForbiddenError("Forbidden"),
    );

    await renderPage({ f: await buildFilterUrlParam(["7", "13"]) });

    expect(mockSearchEventsAtAnchor).toHaveBeenCalledTimes(1);
    const props = capturedShellProps as {
      initialResult: {
        error: string | null;
        forbiddenSensorIds: readonly string[] | null;
      };
    };
    expect(props.initialResult.error).toBe(
      "filters.resultsForbiddenSensor.title",
    );
    expect(props.initialResult.forbiddenSensorIds).toEqual(["7", "13"]);
  });

  // The other classification branches (no-sensor `forbidden` collapsing
  // to the generic scope copy, `DetectionForbiddenError` →
  // `forbidden-customer-scope`, `ReviewUnknownGraphQLError` re-throw,
  // plus `invalid-input` / `server-error` defaults) are pinned in the
  // shared `classifyEventQueryError` unit suite — see
  // `src/__tests__/lib/detection/event-query-error.test.ts`. The page
  // boundary just consumes that classifier output, so re-exercising
  // every branch here would only duplicate coverage.
});
