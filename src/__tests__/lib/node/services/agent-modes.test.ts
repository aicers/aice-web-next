/**
 * Server-side derivation of `service.set_mode` events from persisted
 * before/after agent state. The dialog no longer ships a
 * client-supplied mode diff — these tests pin the behaviour the BFF
 * relies on so it stays trustworthy under the mixed-permission write
 * contract.
 */
import { describe, expect, it } from "vitest";

import { deriveServiceModeChanges } from "@/lib/node/services/agent-modes";
import type { AgentDraftInput, AgentInput } from "@/lib/node/types";

const sensor = (
  draft: string | null = "",
  config: string | null = null,
): AgentInput => ({
  kind: "SENSOR",
  key: "piglet",
  status: "UNKNOWN",
  config,
  draft,
});

const sensorDraft = (draft: string | null = ""): AgentDraftInput => ({
  kind: "SENSOR",
  key: "piglet",
  status: "UNKNOWN",
  draft,
});

const semiDraft = (draft: string | null = ""): AgentDraftInput => ({
  kind: "SEMI_SUPERVISED",
  key: "hog",
  status: "UNKNOWN",
  draft,
});

const semi = (draft: string | null = ""): AgentInput => ({
  kind: "SEMI_SUPERVISED",
  key: "hog",
  status: "UNKNOWN",
  config: null,
  draft,
});

describe("deriveServiceModeChanges", () => {
  it("emits one configure-manually event when create persists an empty Sensor draft", () => {
    expect(deriveServiceModeChanges(null, [sensorDraft("")])).toEqual([
      { serviceKind: "sensor", mode: "configure-manually" },
    ]);
  });

  it("emits zero events when create persists a Sensor in default configure-here mode", () => {
    expect(
      deriveServiceModeChanges(null, [sensorDraft("src_mac = '00:00'")]),
    ).toEqual([]);
  });

  it("emits zero events for an external-service-only create (Data Store has no mode toggle)", () => {
    expect(deriveServiceModeChanges(null, [])).toEqual([]);
  });

  it("emits a configure-manually event when an update flips Sensor here→manually", () => {
    expect(
      deriveServiceModeChanges(
        [sensor("src_mac = '00:00'")],
        [sensorDraft("")],
      ),
    ).toEqual([{ serviceKind: "sensor", mode: "configure-manually" }]);
  });

  it("emits a configure-here event when an update flips Sensor manually→here", () => {
    expect(
      deriveServiceModeChanges(
        [sensor("")],
        [sensorDraft("src_mac = '00:00'")],
      ),
    ).toEqual([{ serviceKind: "sensor", mode: "configure-here" }]);
  });

  it("emits no event when an update only changes a Sensor's draft string but keeps the same mode", () => {
    expect(
      deriveServiceModeChanges(
        [sensor("src_mac = '00:00'")],
        [sensorDraft("src_mac = '11:11'")],
      ),
    ).toEqual([]);
  });

  it("emits no event when an update removes a Sensor agent (membership disable, not mode toggle)", () => {
    expect(deriveServiceModeChanges([sensor("src_mac = '00:00'")], [])).toEqual(
      [],
    );
  });

  it("emits one event per both-mode agent that flipped mode", () => {
    expect(
      deriveServiceModeChanges(
        [sensor(""), semi("models = []")],
        [sensorDraft("src_mac = '00:00'"), semiDraft("")],
      ),
    ).toEqual([
      { serviceKind: "sensor", mode: "configure-here" },
      { serviceKind: "semi-supervised", mode: "configure-manually" },
    ]);
  });

  // `draft: null` on the new side is the wire encoding of "no pending
  // draft", not Manually mode. `buildDraftSubmission` emits `null` for
  // untouched applied-only agents in a metadata-only save and for
  // touched Configure-Here sections whose serialised value already
  // matches the applied config (Keep-editing reconcile no-op). Both
  // cases are zero-mode-change saves; treating them as a here→manually
  // flip would emit phantom `service.set_mode` events for any node
  // edit that didn't touch the agent at all.
  it("emits no event when the new agent has draft:null (no pending change) — applied-only Sensor, metadata-only save", () => {
    expect(
      deriveServiceModeChanges(
        // Old: applied-only Configure-Here Sensor (draft:null, config:<toml>).
        [sensor(null, "src_mac = '00:00'")],
        // New: round-tripped untouched → draft stays null.
        [{ ...sensorDraft(""), draft: null }],
      ),
    ).toEqual([]);
  });

  it("emits no event when the new agent has draft:null on a touched Keep-editing reconcile no-op", () => {
    expect(
      deriveServiceModeChanges(
        // Old: applied Configure-Here Sensor with a pending draft equal
        // to the applied config (the user's edits collapsed back).
        [sensor("src_mac = '00:00'", "src_mac = '00:00'")],
        // New: touched-no-op collapses back to draft:null.
        [{ ...sensorDraft(""), draft: null }],
      ),
    ).toEqual([]);
  });

  // Applied-only baseline: `draft: null` + non-null `config` is the
  // wire shape `seedMembershipFromNode` reads as Configure-Here. The
  // server-side audit derivation must agree, otherwise toggling such
  // an agent to Manually emits no `service.set_mode` row and
  // re-saving while staying in Configure-Here invents a phantom one.
  it("treats applied-only old agent (draft:null + config:<toml>) as Configure-Here", () => {
    // Flipping applied-only Sensor to Manually emits one event.
    expect(
      deriveServiceModeChanges(
        [sensor(null, "src_mac = '00:00'")],
        [sensorDraft("")],
      ),
    ).toEqual([{ serviceKind: "sensor", mode: "configure-manually" }]);
  });

  it("emits no event when applied-only Sensor is re-saved with a Configure-Here draft", () => {
    // Old: `draft: null + config: <toml>` (effective Configure-Here).
    // New: `draft: <toml>` (Configure-Here). Same mode → no event.
    expect(
      deriveServiceModeChanges(
        [sensor(null, "src_mac = '00:00'")],
        [sensorDraft("src_mac = '11:11'")],
      ),
    ).toEqual([]);
  });

  it("treats old agent with both draft and config null as Manually (never-configured)", () => {
    expect(
      deriveServiceModeChanges(
        [sensor(null, null)],
        [sensorDraft("src_mac = '00:00'")],
      ),
    ).toEqual([{ serviceKind: "sensor", mode: "configure-here" }]);
  });

  it("prefers the pending draft over applied config when both are present", () => {
    // Old has a pending Manually draft on top of applied config → old
    // mode is Manually (the draft wins). Flipping to Configure-Here in
    // the new payload emits one event.
    expect(
      deriveServiceModeChanges(
        [sensor("", "src_mac = '00:00'")],
        [sensorDraft("src_mac = '11:11'")],
      ),
    ).toEqual([{ serviceKind: "sensor", mode: "configure-here" }]);
  });
});
