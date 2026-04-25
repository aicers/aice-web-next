import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

// The reviewer's Round-9 callout: Quick peek and Related Events pivots
// encode `kind=` and `window=` in their URLs, but the Detection page
// was previously dropping both on the floor — seeding only
// source/destination into `initialInput` and parking the rest as
// "pivot-only" chip state. That meant `same-kind` landed on an
// unfiltered page and every `window=1d` / `window=7d` pivot silently
// fell back to the default 1h period. Inspect `initialInput`,
// `initialPeriod`, and the `searchEvents` call through a rendered
// capture so a regression in either leg is caught at unit-test time.

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

vi.mock("next-intl/server", () => ({
  getTranslations: mockGetTranslations,
  getLocale: mockGetLocale,
}));

vi.mock("@/components/detection/detection-shell", () => ({
  DetectionShell: mockDetectionShell,
}));

// `DetectionPage` imports the whole `@/lib/detection` facade; stub
// just the entry points the page calls while re-exporting the pure
// helpers (period math, URL parsing, period keys, tag field set) we
// rely on for the assertions. Anything else can default-export
// undefined — the page doesn't touch it before DetectionShell renders.
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
  // Reviewer Round 1 (item 1): the page now prefers the encoded `?f=`
  // URL blob and falls back to the legacy pivot params, so the mock
  // also needs the new `filter-url` exports.
  const filterUrl = await vi.importActual<
    typeof import("@/lib/detection/filter-url")
  >("@/lib/detection/filter-url");
  return {
    ...period,
    ...urlFilters,
    ...pagination,
    ...filterUrl,
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
  THREAT_LEVEL_KEY_BY_VALUE: {},
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
  // The page is a React Server Component returning a `DetectionShell`
  // element; `renderToStaticMarkup` invokes the mocked `DetectionShell`
  // so the captured props reflect what the page hands down.
  renderToStaticMarkup(element);
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
  mockSearchEventsAtAnchor.mockResolvedValue({
    totalCount: "0",
    nodes: [],
    edges: [],
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  });
  vi.resetModules();
});

describe("DetectionPage pivot URL handling", () => {
  it("applies `kind=` to the committed filter's `kinds` so same-kind pivots actually filter", async () => {
    await renderPage({ kind: "HttpThreat", window: "7d" });

    expect(mockSearchEventsAtAnchor).toHaveBeenCalledTimes(1);
    const [, filter] = mockSearchEventsAtAnchor.mock.calls[0];
    expect(filter.mode).toBe("structured");
    expect(filter.input.kinds).toEqual(["HttpThreat"]);

    // Shell is seeded with the matching period so the chip highlights
    // "Last week" and subsequent Apply/Refresh dispatches carry the
    // intended window instead of snapping back to 1h.
    const props = capturedShellProps as { initialPeriod: string };
    expect(props.initialPeriod).toBe("1w");
  });

  it("applies `window=1d` so source/destination pivots land on the last-day slice", async () => {
    await renderPage({ source: "10.0.0.5", window: "1d" });

    expect(mockSearchEventsAtAnchor).toHaveBeenCalledTimes(1);
    const [, filter] = mockSearchEventsAtAnchor.mock.calls[0];
    expect(filter.input.source).toBe("10.0.0.5");
    const start = new Date(filter.input.start).getTime();
    const end = new Date(filter.input.end).getTime();
    // 1d pivot window in milliseconds — the drawer's `1d` period spec.
    expect(end - start).toBe(24 * 60 * 60 * 1000);

    const props = capturedShellProps as { initialPeriod: string };
    expect(props.initialPeriod).toBe("1d");
  });

  it("falls back to the default period (1h) when no `window=` is present", async () => {
    await renderPage({});

    const props = capturedShellProps as { initialPeriod: string };
    expect(props.initialPeriod).toBe("1h");
    const [, filter] = mockSearchEventsAtAnchor.mock.calls[0];
    const start = new Date(filter.input.start).getTime();
    const end = new Date(filter.input.end).getTime();
    expect(end - start).toBe(60 * 60 * 1000);
    expect(filter.input.kinds).toBeUndefined();
  });
});
