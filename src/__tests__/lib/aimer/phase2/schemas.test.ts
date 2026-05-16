import { describe, expect, it } from "vitest";

import {
  isPhase2SchemaVersion,
  PHASE2_PAYLOAD_SCHEMAS,
  PHASE2_SCHEMA_VERSIONS,
  Phase2PayloadValidationError,
  validatePhase2Payload,
} from "@/lib/aimer/phase2/schemas";

// ── Fixture payloads (the minimum each schema accepts) ───────────

function baselinePayload() {
  return {
    external_key: "acmecorp.com",
    source_aice_id: "aice.example.com",
    baseline_version: "1.B.0",
    events: [
      {
        event_key: "12345678901234567890",
        event_time: "2026-05-10T00:00:00Z",
        kind: "HttpThreat",
        raw_event: { foo: "bar" },
      },
    ],
  };
}

function storyPayload() {
  return {
    external_key: "acmecorp.com",
    source_aice_id: "aice.example.com",
    stories: [
      {
        story_id: "12345",
        story_version: "v1",
        kind: "auto_correlated",
        members: [{ event_key: "1234567890", role: "primary" }],
      },
    ],
  };
}

function policyRunPayload() {
  return {
    external_key: "acmecorp.com",
    source_aice_id: "aice.example.com",
    run: {
      run_id: "1234",
      owner_account_id: "11111111-2222-3333-4444-555555555555",
      period_start: "2026-05-01T00:00:00Z",
      period_end: "2026-05-08T00:00:00Z",
      created_at: "2026-05-10T00:00:00Z",
      finalized_at: "2026-05-10T00:01:33Z",
      baseline_version: "1.B.0",
      policies_fingerprint: "abc123",
      exclusions_fingerprint: "def456",
      status: "ready",
    },
    events: [
      {
        event_key: "12345678901234567890",
        event_time: "2026-05-10T00:00:00Z",
        kind: "HttpThreat",
        policy_triage_snapshot: [{ policyId: "P1", score: 0.5 }],
      },
    ],
  };
}

function withdrawPayload() {
  return {
    external_key: "acmecorp.com",
    withdrawals: [
      {
        kind: "baseline_event",
        baseline_version: "1.B.0",
        event_keys: ["1", "2"],
      },
      { kind: "story", story_id: "12345", story_version: "v1" },
      { kind: "policy_event", run_id: "1234", event_keys: ["3"] },
      { kind: "policy_run", run_id: "1234" },
    ],
  };
}

function refreshWindowPayload() {
  return {
    external_key: "acmecorp.com",
    window: {
      kind: "baseline_event",
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-08T00:00:00Z",
    },
    baseline_version: "1.B.0",
    events: [
      {
        event_key: "12345678901234567890",
        event_time: "2026-05-04T00:00:00Z",
        kind: "HttpThreat",
      },
    ],
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("Phase 2 schema registry", () => {
  it("exports one schema per documented schema_version literal", () => {
    expect([...PHASE2_SCHEMA_VERSIONS]).toEqual([
      "phase2.baseline.v1",
      "phase2.story.v1",
      "phase2.policy_run.v1",
      "phase2.withdraw.v1",
      "phase2.refresh_window.v1",
      "phase2.backfill.v1",
    ]);
    for (const v of PHASE2_SCHEMA_VERSIONS) {
      expect(PHASE2_PAYLOAD_SCHEMAS[v]).toBeDefined();
    }
  });

  it("isPhase2SchemaVersion narrows to known literals only", () => {
    expect(isPhase2SchemaVersion("phase2.baseline.v1")).toBe(true);
    expect(isPhase2SchemaVersion("phase2.unknown.v1")).toBe(false);
    expect(isPhase2SchemaVersion("0.0-stub")).toBe(false);
    expect(isPhase2SchemaVersion(123)).toBe(false);
  });

  describe("phase2.baseline.v1", () => {
    it("accepts a well-formed batch", () => {
      expect(() =>
        validatePhase2Payload("phase2.baseline.v1", baselinePayload()),
      ).not.toThrow();
    });

    it("rejects missing required identifiers", () => {
      const p = baselinePayload() as Record<string, unknown>;
      delete p.baseline_version;
      expect(() => validatePhase2Payload("phase2.baseline.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });

    it("rejects event_key that is not a decimal-digit string", () => {
      const p = baselinePayload();
      p.events[0].event_key = "abc";
      expect(() => validatePhase2Payload("phase2.baseline.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });

    it("rejects non-ISO event_time", () => {
      const p = baselinePayload();
      p.events[0].event_time = "not-a-date";
      expect(() => validatePhase2Payload("phase2.baseline.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });
  });

  describe("phase2.story.v1", () => {
    it("accepts a well-formed batch", () => {
      expect(() =>
        validatePhase2Payload("phase2.story.v1", storyPayload()),
      ).not.toThrow();
    });

    it("rejects a story missing story_version", () => {
      const p = storyPayload() as { stories: Array<Record<string, unknown>> };
      delete p.stories[0].story_version;
      expect(() => validatePhase2Payload("phase2.story.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });
  });

  describe("phase2.policy_run.v1", () => {
    it("accepts a well-formed batch", () => {
      expect(() =>
        validatePhase2Payload("phase2.policy_run.v1", policyRunPayload()),
      ).not.toThrow();
    });

    it("rejects status outside {ready, superseded}", () => {
      const p = policyRunPayload();
      (p.run as { status: string }).status = "computing";
      expect(() => validatePhase2Payload("phase2.policy_run.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });
  });

  describe("phase2.withdraw.v1", () => {
    it("accepts the four discriminator variants", () => {
      expect(() =>
        validatePhase2Payload("phase2.withdraw.v1", withdrawPayload()),
      ).not.toThrow();
    });

    it("rejects empty withdrawals array", () => {
      expect(() =>
        validatePhase2Payload("phase2.withdraw.v1", {
          external_key: "acmecorp.com",
          withdrawals: [],
        }),
      ).toThrow(Phase2PayloadValidationError);
    });

    it("rejects baseline_event withdrawal missing baseline_version", () => {
      const p = {
        external_key: "acmecorp.com",
        withdrawals: [{ kind: "baseline_event", event_keys: ["1"] }],
      };
      expect(() => validatePhase2Payload("phase2.withdraw.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });

    it("rejects unknown withdrawal kind", () => {
      const p = {
        external_key: "acmecorp.com",
        withdrawals: [{ kind: "withdraw_unknown" }],
      };
      expect(() => validatePhase2Payload("phase2.withdraw.v1", p)).toThrow(
        Phase2PayloadValidationError,
      );
    });
  });

  describe("phase2.refresh_window.v1 / phase2.backfill.v1", () => {
    it("accepts a baseline-kind refresh window", () => {
      expect(() =>
        validatePhase2Payload(
          "phase2.refresh_window.v1",
          refreshWindowPayload(),
        ),
      ).not.toThrow();
    });

    it("accepts a story-kind refresh window with stories array", () => {
      const p = {
        external_key: "acmecorp.com",
        window: {
          kind: "story",
          from: "2026-05-01T00:00:00Z",
          to: "2026-05-08T00:00:00Z",
        },
        stories: [
          {
            story_id: "1",
            story_version: "v1",
            kind: "auto_correlated",
            members: [{ event_key: "1", role: "primary" }],
          },
        ],
      };
      expect(() =>
        validatePhase2Payload("phase2.refresh_window.v1", p),
      ).not.toThrow();
    });

    it("rejects half-open window with from >= to", () => {
      const p = refreshWindowPayload();
      p.window.from = "2026-05-08T00:00:00Z";
      p.window.to = "2026-05-08T00:00:00Z";
      expect(() =>
        validatePhase2Payload("phase2.refresh_window.v1", p),
      ).toThrow(Phase2PayloadValidationError);
    });

    it("backfill schema accepts the same payload as refresh_window", () => {
      expect(() =>
        validatePhase2Payload("phase2.backfill.v1", refreshWindowPayload()),
      ).not.toThrow();
    });
  });

  it("validation error carries schemaVersion and at least one issue", () => {
    try {
      validatePhase2Payload("phase2.baseline.v1", { external_key: "x" });
      expect.unreachable("validation should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Phase2PayloadValidationError);
      const e = err as Phase2PayloadValidationError;
      expect(e.schemaVersion).toBe("phase2.baseline.v1");
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });
});
