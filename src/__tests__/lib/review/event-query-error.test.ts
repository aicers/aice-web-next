import { describe, expect, it } from "vitest";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";
import { classifyReviewSensorScopeError } from "@/lib/review/event-query-error";

describe("classifyReviewSensorScopeError — shared sensor-scope classifier (#502)", () => {
  // Shared between Detection's `classifyEventQueryError` wrapper and
  // Triage's Tier 2 sensor pivot. Detection layers its own
  // `DetectionForbiddenError` / `DetectionUnauthorizedError` arms on
  // top before delegating here; Triage calls this helper directly
  // because it dispatches `EventListFilterInput` without a
  // Detection-shaped `Filter`.
  it("maps a ReviewForbiddenError with sensors to forbidden-sensor-scope", () => {
    expect(
      classifyReviewSensorScopeError(new ReviewForbiddenError("Forbidden"), [
        "node-1",
        "node-2",
      ]),
    ).toEqual({
      code: "forbidden-sensor-scope",
      unavailableSensorIds: ["node-1", "node-2"],
    });
  });

  it("maps a ReviewForbiddenError without sensors to forbidden", () => {
    expect(
      classifyReviewSensorScopeError(new ReviewForbiddenError("Forbidden"), []),
    ).toEqual({ code: "forbidden" });
  });

  it("maps a ReviewInvalidArgumentError to invalid-input", () => {
    expect(
      classifyReviewSensorScopeError(new ReviewInvalidArgumentError("bad"), []),
    ).toEqual({ code: "invalid-input" });
  });

  it("re-throws ReviewUnknownGraphQLError instead of masking as server-error", () => {
    const err = new ReviewUnknownGraphQLError("future-code");
    expect(() => classifyReviewSensorScopeError(err, [])).toThrow(err);
  });

  it("maps unrelated Error to server-error", () => {
    expect(classifyReviewSensorScopeError(new Error("boom"), [])).toEqual({
      code: "server-error",
    });
  });
});
