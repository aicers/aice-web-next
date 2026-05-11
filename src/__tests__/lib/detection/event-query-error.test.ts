import { describe, expect, it } from "vitest";

import {
  classifyEventQueryError,
  DetectionForbiddenError,
  DetectionUnauthorizedError,
  type Filter,
} from "@/lib/detection";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
  ReviewUnknownGraphQLError,
} from "@/lib/review/errors";

const STRUCTURED_NO_SENSORS: Filter = {
  mode: "structured",
  input: { start: null, end: null },
};

const STRUCTURED_WITH_SENSORS: Filter = {
  mode: "structured",
  input: { start: null, end: null, sensors: ["7", "13"] },
};

describe("classifyEventQueryError — shared SSR / action classifier (#278, #405 I)", () => {
  it("maps DetectionForbiddenError to `forbidden-customer-scope`", () => {
    expect(
      classifyEventQueryError(
        new DetectionForbiddenError("scope"),
        STRUCTURED_NO_SENSORS,
      ),
    ).toEqual({ code: "forbidden-customer-scope" });
  });

  it("maps DetectionUnauthorizedError to `forbidden`", () => {
    expect(
      classifyEventQueryError(
        new DetectionUnauthorizedError("nope"),
        STRUCTURED_NO_SENSORS,
      ),
    ).toEqual({ code: "forbidden" });
  });

  // #278: the customer-scope leg already throws
  // `DetectionForbiddenError` before any review round-trip, so a
  // `ReviewForbiddenError` reaching the classifier with a non-empty
  // `sensors` filter is unambiguously review-web 0.33.0's sensor-out-
  // of-scope path — the SSR bootstrap (cold-load from a bookmarked /
  // tampered URL) needs the same typed classification the client-side
  // action emits so the operator lands on the same "selection no
  // longer accessible" affordance.
  it("maps ReviewForbiddenError with sensors to `forbidden-sensor-scope` and forwards the ids", () => {
    expect(
      classifyEventQueryError(
        new ReviewForbiddenError("Forbidden"),
        STRUCTURED_WITH_SENSORS,
      ),
    ).toEqual({
      code: "forbidden-sensor-scope",
      unavailableSensorIds: ["7", "13"],
    });
  });

  it("maps ReviewForbiddenError without sensors to `forbidden`", () => {
    expect(
      classifyEventQueryError(
        new ReviewForbiddenError("Forbidden"),
        STRUCTURED_NO_SENSORS,
      ),
    ).toEqual({ code: "forbidden" });
  });

  it("maps ReviewInvalidArgumentError to `invalid-input`", () => {
    expect(
      classifyEventQueryError(
        new ReviewInvalidArgumentError("bad"),
        STRUCTURED_NO_SENSORS,
      ),
    ).toEqual({ code: "invalid-input" });
  });

  it("maps unrelated Error to `server-error`", () => {
    expect(
      classifyEventQueryError(new Error("boom"), STRUCTURED_NO_SENSORS),
    ).toEqual({ code: "server-error" });
  });

  // Reviewer Round 2 P1 (carried forward to the shared helper):
  // unrecognised review-side denials must not collapse into the
  // graceful `server-error` bucket — masking new error codes would
  // defeat the security guardrail.
  it("re-throws ReviewUnknownGraphQLError instead of masking as server-error", () => {
    const err = new ReviewUnknownGraphQLError("future-review-code");
    expect(() => classifyEventQueryError(err, STRUCTURED_NO_SENSORS)).toThrow(
      err,
    );
  });

  // A `query`-mode filter has no `sensors` argument; the rejection
  // must collapse to plain `forbidden` rather than asserting against
  // the missing field.
  it("treats query-mode filters as having no sensors", () => {
    const queryFilter: Filter = { mode: "query", text: "" };
    expect(
      classifyEventQueryError(
        new ReviewForbiddenError("Forbidden"),
        queryFilter,
      ),
    ).toEqual({ code: "forbidden" });
  });
});
