import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type {
  EventFilter,
  StatisticsFilter,
  TimeSeriesFilter,
} from "@/lib/event";

import connPage1 from "../../fixtures/external/giganto/connRawEvents.page1.json";
import periodicTimeSeriesFixture from "../../fixtures/external/giganto/periodic-time-series.json";
import sensorsFixture from "../../fixtures/external/giganto/sensors.json";
import statisticsFixture from "../../fixtures/external/giganto/statistics.json";
import samplingPolicyFixture from "../../fixtures/review/sampling-policy-list.json";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

import { RECORD_DESCRIPTORS, RECORD_TYPE_IDS } from "@/lib/event";
import { RAW_EVENT_QUERIES } from "@/lib/event/queries";
import {
  EventPermissionError,
  fetchPeriodicTimeSeries,
  fetchStatistics,
  listEventSensors,
  listSamplingPolicies,
  ManagerUnavailableError,
  searchConnRawEvents,
  searchRawEvents,
} from "@/lib/event/server-actions";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";

const session: AuthSession = {
  accountId: "acct-1",
  roles: ["Tenant Administrator"],
} as AuthSession;

const baseFilter: EventFilter = {
  recordType: "conn",
  sensor: "sensor-a",
  start: "2026-06-09T00:00:00Z",
  end: "2026-06-09T01:00:00Z",
  origAddrStart: null,
  origAddrEnd: null,
  respAddrStart: null,
  respAddrEnd: null,
  origPortStart: null,
  origPortEnd: null,
  respPortStart: null,
  respPortEnd: null,
  agentId: null,
};

beforeEach(() => {
  mockHasPermission.mockReset();
  mockHasPermission.mockImplementation((_roles: string[], perm: string) =>
    Promise.resolve(perm === "event:read"),
  );
  mockResolveEffectiveCustomerIds.mockReset();
  mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
  mockGigantoClient.mockReset();
  mockGraphqlRequest.mockReset();
});

describe("searchConnRawEvents", () => {
  it("throws EventPermissionError when the caller lacks event:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(
      searchConnRawEvents(session, baseFilter, { kind: "head" }, 50),
    ).rejects.toBeInstanceOf(EventPermissionError);
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("throws EventPermissionError for a non-global caller with empty scope", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    await expect(
      searchConnRawEvents(session, baseFilter, { kind: "head" }, 50),
    ).rejects.toBeInstanceOf(EventPermissionError);
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("returns null without dispatching when no sensor is selected", async () => {
    const result = await searchConnRawEvents(
      session,
      { ...baseFilter, sensor: null },
      { kind: "head" },
      50,
    );
    expect(result).toBeNull();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("maps a head anchor to first and returns the connection", async () => {
    mockGigantoClient.mockResolvedValue(connPage1);
    const result = await searchConnRawEvents(
      session,
      baseFilter,
      { kind: "head" },
      50,
    );
    expect(result).toEqual(connPage1.connRawEvents);
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toMatchObject({
      first: 50,
      after: null,
      last: null,
      before: null,
      filter: {
        sensor: "sensor-a",
        time: { start: "2026-06-09T00:00:00Z", end: "2026-06-09T01:00:00Z" },
      },
    });
  });

  it("maps an after anchor to first + after", async () => {
    mockGigantoClient.mockResolvedValue(connPage1);
    await searchConnRawEvents(
      session,
      baseFilter,
      { kind: "after", cursor: "CUR" },
      25,
    );
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toMatchObject({ first: 25, after: "CUR", last: null });
  });

  it("maps a before anchor to last + before", async () => {
    mockGigantoClient.mockResolvedValue(connPage1);
    await searchConnRawEvents(
      session,
      baseFilter,
      { kind: "before", cursor: "CUR" },
      100,
    );
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toMatchObject({ last: 100, before: "CUR", first: null });
  });

  it("omits the customer_ids JWT claim for System Administrator", async () => {
    mockGigantoClient.mockResolvedValue(connPage1);
    await searchConnRawEvents(
      { ...session, roles: ["System Administrator"] } as AuthSession,
      baseFilter,
      { kind: "head" },
      50,
    );
    const [, , context] = mockGigantoClient.mock.calls[0];
    expect(context.customerIds).toBeUndefined();
  });

  it("ships the materialized customer scope for non-admin callers", async () => {
    mockGigantoClient.mockResolvedValue(connPage1);
    await searchConnRawEvents(session, baseFilter, { kind: "head" }, 50);
    const [, , context] = mockGigantoClient.mock.calls[0];
    expect(context.customerIds).toEqual([1]);
  });

  it("maps a Giganto connection failure to ExternalServiceUnavailableError", async () => {
    mockGigantoClient.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      searchConnRawEvents(session, baseFilter, { kind: "head" }, 50),
    ).rejects.toBeInstanceOf(ExternalServiceUnavailableError);
  });
});

describe("searchRawEvents dispatch", () => {
  const connection = {
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    },
    edges: [],
  };

  it.each(
    RECORD_TYPE_IDS,
  )("%s selects its descriptor document and unwraps its response key", async (id) => {
    const descriptor = RECORD_DESCRIPTORS[id];
    mockGigantoClient.mockResolvedValue({
      [descriptor.responseKey]: connection,
    });
    const result = await searchRawEvents(
      session,
      { ...baseFilter, recordType: id },
      { kind: "head" },
      50,
    );
    expect(result).toBe(connection);
    const [document] = mockGigantoClient.mock.calls[0];
    expect(document).toBe(RAW_EVENT_QUERIES[id]);
  });

  it("drops port bounds for the Icmp record type", async () => {
    mockGigantoClient.mockResolvedValue({
      icmpRawEvents: connection,
    });
    await searchRawEvents(
      session,
      {
        ...baseFilter,
        recordType: "icmp",
        origPortStart: 100,
        respPortEnd: 200,
      },
      { kind: "head" },
      50,
    );
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables.filter.origPort).toBeUndefined();
    expect(variables.filter.respPort).toBeUndefined();
  });
});

describe("listEventSensors", () => {
  it("returns the sensor id list", async () => {
    mockGigantoClient.mockResolvedValue(sensorsFixture);
    const sensors = await listEventSensors(session);
    expect(sensors).toEqual(["sensor-a", "sensor-b", "sensor-c"]);
  });

  it("throws EventPermissionError when the caller lacks event:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(listEventSensors(session)).rejects.toBeInstanceOf(
      EventPermissionError,
    );
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });
});

const statsFilter: StatisticsFilter = {
  sensors: ["sensor-a"],
  start: "2026-06-09T00:00:00Z",
  end: "2026-06-09T01:00:00Z",
  protocols: ["conn", "dns"],
};

describe("fetchStatistics", () => {
  it("returns null without dispatching when no sensor is selected", async () => {
    const result = await fetchStatistics(session, {
      ...statsFilter,
      sensors: [],
    });
    expect(result).toBeNull();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("maps the filter to query variables and returns the statistics list", async () => {
    mockGigantoClient.mockResolvedValue(statisticsFixture);
    const result = await fetchStatistics(session, statsFilter);
    expect(result).toEqual(statisticsFixture.statistics);
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toEqual({
      sensors: ["sensor-a"],
      time: { start: "2026-06-09T00:00:00Z", end: "2026-06-09T01:00:00Z" },
      protocols: ["conn", "dns"],
    });
  });

  it("sends null time/protocols when no bounds or subset are set", async () => {
    mockGigantoClient.mockResolvedValue(statisticsFixture);
    await fetchStatistics(session, {
      sensors: ["sensor-a"],
      start: null,
      end: null,
      protocols: [],
    });
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toMatchObject({
      sensors: ["sensor-a"],
      time: null,
      protocols: null,
    });
  });

  it("throws EventPermissionError when the caller lacks event:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(fetchStatistics(session, statsFilter)).rejects.toBeInstanceOf(
      EventPermissionError,
    );
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("maps a Giganto connection failure to ExternalServiceUnavailableError", async () => {
    mockGigantoClient.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchStatistics(session, statsFilter)).rejects.toBeInstanceOf(
      ExternalServiceUnavailableError,
    );
  });
});

const tsFilter: TimeSeriesFilter = {
  id: "policy-1",
  start: "2026-06-09T00:00:00Z",
  end: "2026-06-09T01:00:00Z",
};

describe("fetchPeriodicTimeSeries", () => {
  it("returns null without dispatching when no policy id is selected", async () => {
    const result = await fetchPeriodicTimeSeries(session, {
      ...tsFilter,
      id: null,
    });
    expect(result).toBeNull();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("maps the filter to query variables and returns the series nodes", async () => {
    mockGigantoClient.mockResolvedValue(periodicTimeSeriesFixture);
    const result = await fetchPeriodicTimeSeries(session, tsFilter);
    expect(result).toEqual(periodicTimeSeriesFixture.periodicTimeSeries.nodes);
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables).toMatchObject({
      filter: {
        id: "policy-1",
        time: { start: "2026-06-09T00:00:00Z", end: "2026-06-09T01:00:00Z" },
      },
      first: 100,
      after: null,
      last: null,
      before: null,
    });
  });

  it("omits the time window when no bound is set", async () => {
    mockGigantoClient.mockResolvedValue(periodicTimeSeriesFixture);
    await fetchPeriodicTimeSeries(session, {
      id: "policy-1",
      start: null,
      end: null,
    });
    const [, variables] = mockGigantoClient.mock.calls[0];
    expect(variables.filter).toEqual({ id: "policy-1" });
  });

  it("throws EventPermissionError when the caller lacks event:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(
      fetchPeriodicTimeSeries(session, tsFilter),
    ).rejects.toBeInstanceOf(EventPermissionError);
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("maps a Giganto connection failure to ExternalServiceUnavailableError", async () => {
    mockGigantoClient.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      fetchPeriodicTimeSeries(session, tsFilter),
    ).rejects.toBeInstanceOf(ExternalServiceUnavailableError);
  });
});

describe("listSamplingPolicies", () => {
  it("dispatches to REview via graphqlRequest and returns the policy nodes", async () => {
    mockGraphqlRequest.mockResolvedValue(samplingPolicyFixture);
    const result = await listSamplingPolicies(session);
    expect(result).toEqual(samplingPolicyFixture.samplingPolicyList.nodes);
    expect(mockGigantoClient).not.toHaveBeenCalled();
    const [, variables] = mockGraphqlRequest.mock.calls[0];
    expect(variables).toMatchObject({ first: 100 });
  });

  it("ships the materialized customer scope for non-admin callers", async () => {
    mockGraphqlRequest.mockResolvedValue(samplingPolicyFixture);
    await listSamplingPolicies(session);
    const [, , context] = mockGraphqlRequest.mock.calls[0];
    expect(context.customerIds).toEqual([1]);
  });

  it("omits the customer_ids JWT claim for System Administrator", async () => {
    mockGraphqlRequest.mockResolvedValue(samplingPolicyFixture);
    await listSamplingPolicies({
      ...session,
      roles: ["System Administrator"],
    } as AuthSession);
    const [, , context] = mockGraphqlRequest.mock.calls[0];
    expect(context.customerIds).toBeUndefined();
  });

  it("throws EventPermissionError when the caller lacks event:read", async () => {
    mockHasPermission.mockResolvedValue(false);
    await expect(listSamplingPolicies(session)).rejects.toBeInstanceOf(
      EventPermissionError,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("maps a REview connection failure to ManagerUnavailableError", async () => {
    mockGraphqlRequest.mockRejectedValue(new TypeError("fetch failed"));
    await expect(listSamplingPolicies(session)).rejects.toBeInstanceOf(
      ManagerUnavailableError,
    );
  });
});
