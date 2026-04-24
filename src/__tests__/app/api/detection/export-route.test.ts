import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/auth/jwt";
import {
  AVERAGE_CSV_ROW_BYTES,
  CSV_COLUMN_KEYS,
  type CsvColumnHeaders,
  DEFAULT_CSV_HEADERS,
  LARGE_EXPORT_ROW_THRESHOLD,
} from "@/lib/detection/csv-export";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockSearchEvents = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (request: NextRequest, context: unknown) => {
      if (options?.requiredPermissions) {
        for (const perm of options.requiredPermissions) {
          if (!(await mockHasPermission(currentSession.roles, perm))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
      }
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/detection/server-actions", () => ({
  searchEvents: mockSearchEvents,
}));

const ROW_OPTIONS = {
  levelLabels: { LOW: "Low", MEDIUM: "Medium", HIGH: "High" },
  categoryLabels: {},
  countryUnknown: "??",
  countryUnavailable: "—",
  triageSummaryTemplate: "{count} policies · {max} max",
  moreCountSuffixTemplate: "+{count} more",
};

function buildSession(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/detection/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildHeaders(): CsvColumnHeaders {
  return { ...DEFAULT_CSV_HEADERS };
}

const VALID_FILTER = {
  mode: "structured" as const,
  input: {
    start: "2026-04-22T00:00:00.000Z",
    end: "2026-04-22T01:00:00.000Z",
  },
};

describe("POST /api/detection/export", () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockSearchEvents.mockReset();
    currentSession = buildSession();
  });

  it("returns 400 when filter is missing or malformed", async () => {
    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when headers are incomplete", async () => {
    const { POST } = await import("@/app/api/detection/export/route");

    const partial: Record<string, string> = {};
    for (const key of CSV_COLUMN_KEYS.slice(0, 2)) partial[key] = "h";

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: partial,
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 confirmation-required when totalCount meets the threshold", async () => {
    mockSearchEvents.mockResolvedValueOnce({
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
      nodes: [],
      totalCount: String(LARGE_EXPORT_ROW_THRESHOLD + 1),
    });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("confirmation-required");
    expect(json.totalCount).toBe(String(LARGE_EXPORT_ROW_THRESHOLD + 1));
    expect(json.threshold).toBe(LARGE_EXPORT_ROW_THRESHOLD);
    expect(json.estimatedBytes).toBe(
      (LARGE_EXPORT_ROW_THRESHOLD + 1) * AVERAGE_CSV_ROW_BYTES,
    );
  });

  it("streams a 200 CSV when totalCount is under the threshold", async () => {
    // Two calls: one to fetch row count, one to start the stream.
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: "LATERAL_MOVEMENT",
      level: "HIGH",
      triageScores: null,
      origAddr: "10.0.0.5",
      origPort: 1234,
      respAddr: "10.0.0.6",
      respPort: 443,
    };
    mockSearchEvents
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "2",
      })
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          { cursor: "c1", node: event },
          { cursor: "c2", node: event },
        ],
        nodes: [event, event],
        totalCount: "2",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
        periodKey: "1h",
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(
      "detection-events_",
    );
    expect(res.headers.get("Content-Disposition")).toContain("last-1h");
    expect(res.headers.get("X-Total-Count")).toBe("2");

    const body = await res.text();
    const lines = body.split("\r\n").filter((l) => l !== "");
    // Header + 2 rows.
    expect(lines.length).toBe(3);
    // CSV column order mirrors the result row — severity lands
    // first, not the timestamp.
    expect(lines[0].split(",")[0]).toBe(DEFAULT_CSV_HEADERS.level);
    expect(lines[1]).toContain("HTTP Threat");
  });

  it("paginates through multiple pages until hasNextPage flips false", async () => {
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    };
    mockSearchEvents
      // count probe
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "3",
      })
      // page 1 (has next)
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: true, endCursor: "cursor-page-1-end" },
        edges: [
          { cursor: "a", node: event },
          { cursor: "b", node: event },
        ],
        nodes: [event, event],
        totalCount: "3",
      })
      // page 2 (final)
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ cursor: "c", node: event }],
        nodes: [event],
        totalCount: "3",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    const dataLines = body
      .split("\r\n")
      .filter((l) => l !== "")
      .slice(1);
    expect(dataLines.length).toBe(3);

    // The page-2 call must be made with the cursor from page-1's
    // endCursor so the iteration actually advances.
    const calls = mockSearchEvents.mock.calls;
    expect(calls[2][2].after).toBe("cursor-page-1-end");
  });

  it("returns 413 row-limit-exceeded when totalCount is above the hard cap", async () => {
    const { CSV_EXPORT_MAX_ROWS } = await import(
      "@/lib/detection/export-stream"
    );
    mockSearchEvents.mockResolvedValueOnce({
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
      nodes: [],
      totalCount: String(CSV_EXPORT_MAX_ROWS + 1),
    });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
        confirmedLargeExport: true,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(413);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("row-limit-exceeded");
    expect(json.totalCount).toBe(String(CSV_EXPORT_MAX_ROWS + 1));
    expect(json.limit).toBe(CSV_EXPORT_MAX_ROWS);
  });

  it("aborts the stream when hasNextPage is true but endCursor is missing", async () => {
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    };
    mockSearchEvents
      // count probe
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "5",
      })
      // streaming page: claims more pages yet yields no cursor
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: true, endCursor: null },
        edges: [{ cursor: "a", node: event }],
        nodes: [event],
        totalCount: "5",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    // Reading the body must reject because the stream was
    // `controller.error(...)`-ed instead of cleanly closed.
    await expect(res.text()).rejects.toThrow(/endCursor was missing/);
  });

  it("aborts the stream when endCursor does not advance between pages", async () => {
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    };
    mockSearchEvents
      // count probe
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "5",
      })
      // streaming page 1
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: true, endCursor: "stuck-cursor" },
        edges: [{ cursor: "a", node: event }],
        nodes: [event],
        totalCount: "5",
      })
      // streaming page 2: cursor repeats page 1's cursor
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: true, endCursor: "stuck-cursor" },
        edges: [{ cursor: "b", node: event }],
        nodes: [event],
        totalCount: "5",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(/did not advance/);
  });

  it("echoes a client-pinned filename in Content-Disposition when it is safe", async () => {
    // Reviewer Round 8: the Chromium save picker's suggestedName and
    // the Content-Disposition header used to drift because the client
    // always advertised `detection-events.csv` while the server built
    // its own timestamped name. The fix threads the client filename
    // through so both sides agree.
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    };
    mockSearchEvents
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "1",
      })
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ cursor: "a", node: event }],
        nodes: [event],
        totalCount: "1",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
        periodKey: "1h",
        filename: "detection-events_2026-04-20T15-32_last-1h.csv",
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="detection-events_2026-04-20T15-32_last-1h.csv"',
    );
  });

  it("ignores an unsafe client filename and builds its own", async () => {
    // Raw quotes or CR/LF in the filename would let a caller smuggle
    // headers via Content-Disposition. The sanitizer whitelists the
    // same character class the filename builder emits, so anything
    // else is dropped in favour of a freshly-built name.
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    };
    mockSearchEvents
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: "1",
      })
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ cursor: "a", node: event }],
        nodes: [event],
        totalCount: "1",
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
        periodKey: "1h",
        filename: 'evil.csv"; attachment=x',
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toContain('evil.csv"');
    expect(disposition).toMatch(/^attachment; filename="detection-events_/);
    expect(disposition).toContain("last-1h");
  });

  it("allows the export when confirmedLargeExport is true even at the threshold", async () => {
    const event = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "HIGH",
      triageScores: null,
    };
    mockSearchEvents
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [],
        nodes: [],
        totalCount: String(LARGE_EXPORT_ROW_THRESHOLD + 5),
      })
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ cursor: "x", node: event }],
        nodes: [event],
        totalCount: String(LARGE_EXPORT_ROW_THRESHOLD + 5),
      });

    const { POST } = await import("@/app/api/detection/export/route");

    const res = await POST(
      makeRequest({
        filter: VALID_FILTER,
        headers: buildHeaders(),
        formatRowOptions: ROW_OPTIONS,
        confirmedLargeExport: true,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
  });
});
