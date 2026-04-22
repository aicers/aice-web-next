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

describe("detection sensors — listSensors()", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  // ── Authorization ──────────────────────────────────────────────

  it("rejects a caller without detection:read before resolving scope", async () => {
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

  it("rejects a caller with an empty customer scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);

    const { listSensors, DetectionUnauthorizedError } = await import(
      "@/lib/detection"
    );

    await expect(listSensors(makeSession())).rejects.toBeInstanceOf(
      DetectionUnauthorizedError,
    );

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("resolves customer_ids for authorized callers before the endpoint check", async () => {
    // Forward-looking assertion for the customer-scope contract: the
    // customer_ids list is materialized on every call, even while the
    // endpoint is absent, so flipping `SENSOR_LIST_ENDPOINT_AVAILABLE`
    // and wiring the dispatch does not require touching the auth path.
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

  // ── Fallback: endpoint absent from vendored schema ─────────────

  it("returns the endpoint-absent variant (and an empty list via sensorsOrEmpty) when the endpoint is missing from the vendored schema", async () => {
    // The vendored schemas/review.graphql does not yet expose the
    // sensor-list query (#295). While that is true, authorized callers
    // must receive the `endpoint-absent` variant rather than an error —
    // downstream consumers (#278 dropdown, #291 event locator) rely on
    // this degrade-gracefully contract and choose between the
    // discriminator (locator) or `sensorsOrEmpty()` (dropdown).
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);

    const { listSensors, SENSOR_LIST_ENDPOINT_AVAILABLE, sensorsOrEmpty } =
      await import("@/lib/detection");

    // Precondition for this regression: the constant really is `false`
    // in the current snapshot of the vendored schema.
    expect(SENSOR_LIST_ENDPOINT_AVAILABLE).toBe(false);

    const result = await listSensors(makeSession());
    expect(result).toEqual({ endpointAvailable: false });
    // The documented collapse helper still yields the flat empty list
    // that the issue's fallback clause calls out.
    expect(sensorsOrEmpty(result)).toEqual([]);
    // No network traffic at all while the endpoint is absent.
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  // ── Consumer-side compile-time guard ───────────────────────────

  it("forces consumers to acknowledge the endpoint-availability state at the type level", async () => {
    // This test is primarily a tsc-level assertion: the compile guard
    // is the SensorListResult discriminated union itself (see
    // src/lib/detection/sensors.ts). A consumer that treats the result
    // as always having a `sensors` field — i.e. assumes the endpoint is
    // always available — fails `tsc --noEmit` because `sensors` does
    // not exist on the `endpoint-absent` variant. The @ts-expect-error
    // lines below lock that guard in: if anyone widens the return
    // shape to always expose `sensors`, the directives become dead and
    // tsc fails the test file.
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

  // ── Wire-path guard: activates when the flag flips ─────────────

  it("dispatches via graphqlRequest with { role, customerIds } once the endpoint flag is true", async () => {
    // Behavioural counterpart to the schema-vs-constant guard in
    // `sensors-endpoint-guard.test.ts`. Today this test is a no-op
    // because `SENSOR_LIST_ENDPOINT_AVAILABLE` is `false`, but it
    // activates automatically the moment someone flips the constant:
    //
    //   - If the dispatch body is still `return []`, `graphqlRequest`
    //     is never called and this assertion fails — so a future PR
    //     cannot flip the flag and leave the fallback as the live
    //     code path.
    //   - The assertion also locks the wire contract: the caller's
    //     `customer_ids` travel on the Context JWT (via `graphqlRequest`
    //     which calls `signContextJwt(role, customerIds)` internally —
    //     see review-integration.test.ts), not on the query variables.
    //
    // Run against the real constant (not a mocked one) so the guard
    // tracks the production flag, not a test-local override.
    const { listSensors, SENSOR_LIST_ENDPOINT_AVAILABLE } = await import(
      "@/lib/detection"
    );
    if (!SENSOR_LIST_ENDPOINT_AVAILABLE) {
      // Flag is still `false`: the fallback path is exercised by the
      // preceding test. When REview publishes the sensor-list query
      // (#295) and the constant flips, the assertions below activate
      // and require a wired graphqlRequest dispatch in listSensors.
      return;
    }

    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);
    mockGraphqlRequest.mockResolvedValue({
      sensorList: [] as Array<{ id: string; name: string; customerId: string }>,
    });

    await listSensors(makeSession({ roles: ["Security Monitor"] }));

    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    const call = mockGraphqlRequest.mock.calls[0];
    // graphqlRequest signature: (document, variables, context).
    // Assert only the context — the document and variables are part
    // of the wiring change and will be locked in by the PR that
    // flips the flag.
    expect(call[2]).toMatchObject({
      role: "Security Monitor",
      customerIds: [42, 99],
    });
  });
});
