import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import { PcapCapExceededError } from "@/lib/detection/pcap";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockFetchDetectionPackets = vi.hoisted(() => vi.fn());

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
  fetchDetectionPackets: mockFetchDetectionPackets,
}));

import { buildPcapFilename, GET } from "@/app/api/detection/pcap/route";

const SENSOR = "sensor-a";
const REQUEST_TIME = "2026-06-09T00:00:00.000Z";
const FRAME_B64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64");

function buildSession(): AuthSession {
  return { accountId: "account-1", roles: ["Security Monitor"] } as AuthSession;
}

function makeRequest(query: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/detection/pcap");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/detection/pcap", () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockFetchDetectionPackets.mockReset();
    currentSession = buildSession();
  });

  it("returns a binary .pcap with an attachment disposition", async () => {
    mockFetchDetectionPackets.mockResolvedValue([
      { packetTime: REQUEST_TIME, packet: FRAME_B64 },
    ]);
    const res = await GET(
      makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.tcpdump.pcap",
    );
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(".pcap");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Global header (24 bytes) + record header (16) + 4 payload bytes.
    expect(bytes.byteLength).toBe(44);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0xa1b2c3d4);
    expect(mockFetchDetectionPackets).toHaveBeenCalledWith(
      currentSession,
      SENSOR,
      REQUEST_TIME,
      expect.anything(),
    );
  });

  it("returns 404 no-packet-data (not a 200 file) for an empty capture", async () => {
    mockFetchDetectionPackets.mockResolvedValue([]);
    const res = await GET(
      makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no-packet-data" });
    // No header-only file is served.
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("logs once when a packet has an unparseable packetTime", async () => {
    mockFetchDetectionPackets.mockResolvedValue([
      { packetTime: REQUEST_TIME, packet: FRAME_B64 },
      { packetTime: "not-a-time", packet: FRAME_B64 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await GET(
        makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }),
        { params: Promise.resolve({}) },
      );
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(SENSOR);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log when every packetTime parses", async () => {
    mockFetchDetectionPackets.mockResolvedValue([
      { packetTime: REQUEST_TIME, packet: FRAME_B64 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await GET(makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }), {
        params: Promise.resolve({}),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a missing sensor with 400 and never fetches", async () => {
    const res = await GET(makeRequest({ requestTime: REQUEST_TIME }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    expect(mockFetchDetectionPackets).not.toHaveBeenCalled();
  });

  it("rejects a malformed requestTime with 400", async () => {
    const res = await GET(
      makeRequest({ sensor: SENSOR, requestTime: "not-a-time" }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect(mockFetchDetectionPackets).not.toHaveBeenCalled();
  });

  it("maps the hard cap to 413", async () => {
    mockFetchDetectionPackets.mockRejectedValue(
      new PcapCapExceededError("packets"),
    );
    const res = await GET(
      makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "pcap-cap-exceeded" });
  });

  it("returns 403 when the caller lacks detection:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    const res = await GET(
      makeRequest({ sensor: SENSOR, requestTime: REQUEST_TIME }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
    expect(mockFetchDetectionPackets).not.toHaveBeenCalled();
  });
});

describe("buildPcapFilename", () => {
  it("produces distinct names for long sensor ids sharing a 120-char prefix", () => {
    const prefix = "s".repeat(120);
    const a = buildPcapFilename(`${prefix}-alpha`, REQUEST_TIME);
    const b = buildPcapFilename(`${prefix}-bravo`, REQUEST_TIME);
    expect(a).not.toBe(b);
    expect(a.endsWith(".pcap")).toBe(true);
    expect(b.endsWith(".pcap")).toBe(true);
  });

  it("is deterministic for the same sensor id", () => {
    expect(buildPcapFilename(SENSOR, REQUEST_TIME)).toBe(
      buildPcapFilename(SENSOR, REQUEST_TIME),
    );
  });

  it("keeps CR/LF, quotes, and path separators out of the filename", () => {
    const hostile = 'evil"\r\nSet-Cookie: x=y/../../etc/passwd';
    const filename = buildPcapFilename(hostile, REQUEST_TIME);
    expect(filename).not.toMatch(/[\r\n"/\\]/);
    // Only the filename-safe alphabet survives.
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("stays within the safe alphabet even with a hostile timestamp", () => {
    const filename = buildPcapFilename(SENSOR, '2026-01-01"\r\nX: y');
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
