import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/graphql/external-client", () => ({
  gigantoClient: mockGigantoClient,
  tivanClient: vi.fn(),
}));

// `graphqlRequest` (manager) is unused by these helpers but imported by
// the module under test; stub it so the module loads without a real
// transport.
vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: vi.fn(),
}));

import {
  DetectionForbiddenError,
  DetectionUnauthorizedError,
} from "@/lib/detection/errors";
import { PCAP_MAX_PACKETS, PcapCapExceededError } from "@/lib/detection/pcap";
import {
  fetchDetectionPackets,
  fetchDetectionPcap,
} from "@/lib/detection/server-actions";

const session: AuthSession = {
  accountId: "acct-1",
  roles: ["Tenant Administrator"],
} as AuthSession;

const SENSOR = "sensor-a";
const REQUEST_TIME = "2026-06-09T00:00:00Z";

function packetsPage(
  nodes: { packetTime: string; packet: string }[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    packets: {
      pageInfo: { hasNextPage, endCursor },
      nodes: nodes.map((n) => ({ requestTime: REQUEST_TIME, ...n })),
    },
  };
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockHasPermission.mockImplementation((_roles: string[], perm: string) =>
    Promise.resolve(perm === "detection:read"),
  );
  mockResolveEffectiveCustomerIds.mockReset();
  mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
  mockGigantoClient.mockReset();
});

describe("fetchDetectionPcap", () => {
  it("dispatches the pcap query and returns the parsed text", async () => {
    mockGigantoClient.mockResolvedValue({
      pcap: { requestTime: REQUEST_TIME, parsedPcap: "1  0.0  ETHER ..." },
    });
    const result = await fetchDetectionPcap(session, SENSOR, REQUEST_TIME);
    expect(result.parsedPcap).toContain("ETHER");
    const [, variables, context] = mockGigantoClient.mock.calls[0];
    expect(variables).toEqual({
      filter: { sensor: SENSOR, requestTime: REQUEST_TIME },
    });
    // Non-SystemAdministrator caller ships its materialized scope.
    expect(context).toMatchObject({ customerIds: [1] });
  });

  it("rejects without dispatching when the caller lacks detection:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(
      fetchDetectionPcap(session, SENSOR, REQUEST_TIME),
    ).rejects.toBeInstanceOf(DetectionUnauthorizedError);
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("rejects a non-global caller with an empty customer scope", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    await expect(
      fetchDetectionPcap(session, SENSOR, REQUEST_TIME),
    ).rejects.toBeInstanceOf(DetectionForbiddenError);
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });
});

describe("fetchDetectionPackets", () => {
  it("pages through the connection following hasNextPage", async () => {
    mockGigantoClient
      .mockResolvedValueOnce(
        packetsPage(
          [{ packetTime: REQUEST_TIME, packet: "AAA=" }],
          true,
          "cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        packetsPage(
          [{ packetTime: REQUEST_TIME, packet: "BBB=" }],
          false,
          "cursor-2",
        ),
      );
    const records = await fetchDetectionPackets(session, SENSOR, REQUEST_TIME);
    expect(records.map((r) => r.packet)).toEqual(["AAA=", "BBB="]);
    expect(mockGigantoClient).toHaveBeenCalledTimes(2);
    // The second call advances the cursor.
    expect(mockGigantoClient.mock.calls[1][1]).toMatchObject({
      after: "cursor-1",
    });
  });

  it("aborts when hasNextPage is set but the cursor does not advance", async () => {
    mockGigantoClient.mockResolvedValue(
      packetsPage([{ packetTime: REQUEST_TIME, packet: "AAA=" }], true, null),
    );
    await expect(
      fetchDetectionPackets(session, SENSOR, REQUEST_TIME),
    ).rejects.toThrow(/pagination aborted/);
  });

  it("enforces the hard packet-count cap", async () => {
    // A single page one past the cap trips the ceiling: the loop
    // throws when it reaches the (cap + 1)-th node rather than
    // returning a silently truncated capture.
    const nodes = Array.from({ length: PCAP_MAX_PACKETS + 1 }, () => ({
      packetTime: REQUEST_TIME,
      packet: "AAA=",
    }));
    mockGigantoClient.mockResolvedValue(packetsPage(nodes, false, null));
    await expect(
      fetchDetectionPackets(session, SENSOR, REQUEST_TIME),
    ).rejects.toBeInstanceOf(PcapCapExceededError);
  });
});
