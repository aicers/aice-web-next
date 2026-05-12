import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

/** Build a minimally-populated AuthSession for the unit under test. */
function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 1,
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
    ...overrides,
  } as AuthSession;
}

const EMPTY_SENSOR_LIST_RESPONSE = {
  customerSensorList: { nodes: [] as Array<unknown> },
};

describe("detection sensors — listSensors()", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
    mockGraphqlRequest.mockResolvedValue(EMPTY_SENSOR_LIST_RESPONSE);
  });

  // ── Authorization ──────────────────────────────────────────────

  it("rejects a caller without detection:read or triage:read before resolving scope", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { listSensors, DetectionUnauthorizedError } = await import(
      "@/lib/detection"
    );

    await expect(listSensors(makeSession())).rejects.toBeInstanceOf(
      DetectionUnauthorizedError,
    );

    // Authorization failure short-circuits before scope resolution
    // and before any GraphQL dispatch.
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("accepts a triage:read-only caller (no detection:read) — #502 permission union", async () => {
    // Tier 2 sensor pivot reuses listSensors() and operators may
    // hold triage:read without detection:read. The lookup is
    // read-only metadata already customer-scoped via the JWT, so
    // the permission union does not widen what data the caller
    // sees — it just keeps the sensor pivot from implicitly
    // requiring detection:read.
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "triage:read" || permission === "customers:access-all",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockResolvedValue({
      customerSensorList: {
        nodes: [{ customerId: 42, nodeId: "1", hostFqdn: "edge-01" }],
      },
    });

    const { listSensors } = await import("@/lib/detection");
    const result = await listSensors(makeSession({ roles: ["Triage Reader"] }));

    expect(result).toEqual({
      endpointAvailable: true,
      sensors: [{ id: "1", name: "edge-01", customerId: 42 }],
    });
  });

  it("rejects a non-admin caller with an empty customer scope", async () => {
    // Non-admin (no `customers:access-all`): the empty-scope gate
    // applies as before. The bypass for access-all callers — see
    // the dedicated test below — is a separate path. The error class
    // is intentionally `DetectionUnauthorizedError`, not
    // `DetectionForbiddenError`: `sensor-actions.ts` catches the
    // former and maps it to `code: "forbidden"` for the drawer; see
    // the rationale in `sensors.ts`.
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "detection:read",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);

    const { listSensors, DetectionUnauthorizedError } = await import(
      "@/lib/detection"
    );

    await expect(listSensors(makeSession())).rejects.toBeInstanceOf(
      DetectionUnauthorizedError,
    );

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("does not block an access-all caller (e.g. SysAdmin) with an empty local customers table (#405 L1)", async () => {
    // Symmetric to the bypass in `buildDispatchContext`: a fresh
    // install with no `customers` rows must not lock SysAdmin out
    // of the sensor enumeration. The dispatch still happens — review
    // accepts `customer_ids = None` for SysAdmin (review's "all
    // customers" wire semantics) and enumerates every customer's
    // sensors. The BFF's empty-scope gate must NOT trip along the way.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);

    const { listSensors } = await import("@/lib/detection");
    const result = await listSensors(
      makeSession({ roles: ["System Administrator"] }),
    );

    expect(result).toEqual({ endpointAvailable: true, sensors: [] });
    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    const ctx = mockGraphqlRequest.mock.calls[0][2];
    expect(ctx).toEqual({
      role: "System Administrator",
      // SystemAdministrator → `customer_ids = None` on the wire (the
      // JWT-claim helper returns `undefined`).
      customerIds: undefined,
    });
  });

  it("resolves customer_ids for authorized callers before dispatch", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);

    const { listSensors } = await import("@/lib/detection");
    await listSensors(makeSession());

    expect(mockHasPermission).toHaveBeenCalledWith(
      ["Security Monitor"],
      "detection:read",
    );
    expect(mockResolveEffectiveCustomerIds).toHaveBeenCalledWith("account-1", [
      "Security Monitor",
    ]);
  });

  // ── Consumer-side compile-time guard ───────────────────────────

  it("forces consumers to acknowledge the endpoint-availability state at the type level", async () => {
    // This test is primarily a tsc-level assertion: the compile guard
    // is the SensorListResult discriminated union itself (see
    // src/lib/detection/sensors.ts). A consumer that treats the result
    // as always having a `sensors` field — i.e. assumes the endpoint is
    // always available — fails `tsc --noEmit` because `sensors` does
    // not exist on the `endpoint-absent` variant. The @ts-expect-error
    // line below locks that guard in: if anyone widens the return
    // shape to always expose `sensors`, the directive becomes dead and
    // tsc fails the test file.
    //
    // The discriminator stays in place even after the endpoint has
    // shipped because a future REview schema rollback would flip
    // `SENSOR_LIST_ENDPOINT_AVAILABLE` back to `false` and consumers
    // need a typed signal to fall back to (#278's "Coming soon"
    // affordance, #291's name → ID skip).
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);

    const { listSensors } = await import("@/lib/detection");
    const result = await listSensors(makeSession());

    // @ts-expect-error — `sensors` is only present on the
    // `endpointAvailable: true` variant; accessing it without first
    // narrowing on the discriminator is a type error, which is
    // exactly the consumer-side guard the issue requires.
    void result.sensors;

    // With proper narrowing, `sensors` is reachable and typed.
    if (result.endpointAvailable) {
      const sensors: readonly unknown[] = result.sensors;
      expect(Array.isArray(sensors)).toBe(true);
    } else {
      expect(result).toEqual({ endpointAvailable: false });
    }
  });

  // ── Dispatch contract ──────────────────────────────────────────

  it("dispatches via graphqlRequest with { role, customerIds } and projects the response", async () => {
    // Wire contract: caller's `customer_ids` travel on the Context JWT
    // (`graphqlRequest` calls `signContextJwt(role, customerIds)`
    // internally — see review-integration.test.ts), not on the query
    // variables. No explicit `customerIds` argument is sent to
    // `customerSensorList`; review uses the JWT-claim set to scope.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);
    mockGraphqlRequest.mockResolvedValue({
      customerSensorList: {
        nodes: [
          { customerId: 42, nodeId: "1", hostFqdn: "sensor-a.example.com" },
          { customerId: 99, nodeId: "2", hostFqdn: "sensor-b.example.com" },
        ],
      },
    });

    const { listSensors } = await import("@/lib/detection");
    const result = await listSensors(
      makeSession({ roles: ["Security Monitor"] }),
    );

    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    const call = mockGraphqlRequest.mock.calls[0];
    // graphqlRequest signature: (document, variables, context).
    expect(call[1]).toBeUndefined();
    expect(call[2]).toEqual({
      role: "Security Monitor",
      customerIds: [42, 99],
    });

    // Projection at the boundary: SDL `nodeId` → public `id`,
    // SDL `hostFqdn` → public `name`, numeric `customerId` preserved.
    expect(result).toEqual({
      endpointAvailable: true,
      sensors: [
        { id: "1", name: "sensor-a.example.com", customerId: 42 },
        { id: "2", name: "sensor-b.example.com", customerId: 99 },
      ],
    });
  });
});
