import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en.json";
import koMessages from "@/i18n/messages/ko.json";
import {
  getService,
  listServices,
  registerService,
  resetRegistry,
} from "@/lib/node/service-registry";
import type { ServiceFormModule } from "@/lib/node/services/types";

describe("service registry", () => {
  it("auto-registers the six services from this sub-issue", () => {
    const kinds = listServices().map((s) => s.kind);
    expect(kinds).toEqual([
      "sensor",
      "data-store",
      "ti-container",
      "semi-supervised",
      "time-series",
      "unsupervised",
    ]);
  });

  it("getService(kind) returns the matching entry", () => {
    expect(getService("ti-container").serviceKey).toBe("tivan");
    // Round 16 follow-up: `mode` distinguishes the three configuration
    // entry-points the dialog needs to render — `configure-here only`
    // (no toggle), `configure-manually only` (Unsupervised), and
    // `both` (the agents that expose a Configure-Here / Manually
    // toggle). Collapsing this into `supportsManualMode: boolean` lost
    // the manual-only vs configure-here-only distinction.
    expect(getService("sensor").mode).toBe("both");
    expect(getService("data-store").mode).toBe("configure-here");
    expect(getService("ti-container").mode).toBe("configure-here");
    expect(getService("semi-supervised").mode).toBe("both");
    expect(getService("time-series").mode).toBe("both");
    expect(getService("unsupervised").mode).toBe("configure-manually");
  });

  it("unsupervised ships configure-manually with a non-null informational formComponent", () => {
    // Round 20 follow-up: the registry contract (see the JSDoc on
    // `ServiceMode` and `formComponent`) treats `formComponent` as the
    // per-service component the dialog renders inside that service's
    // accordion body. For `configure-manually` services, that component
    // is an informational panel rendered alongside the manual editor —
    // not a data-bound form. Unsupervised Engine is the canonical case:
    // mode is `configure-manually`, but the registry still publishes
    // `UnsupervisedEnginePanel` so the dialog has one place to read
    // accordion-body content from for every service. This pins that
    // single coherent rule against any future "manual mode means
    // formComponent must be null" regression.
    const entry = getService("unsupervised");
    expect(entry.mode).toBe("configure-manually");
    expect(entry.formComponent).not.toBeNull();
  });

  it("each default entry exposes its rendered form component", () => {
    // Wiring the components into the registry is the whole point of
    // the source-of-truth contract: the dialog layer must be able to
    // discover what to render from `getService(kind).formComponent`
    // without an out-of-band override map.
    for (const kind of [
      "sensor",
      "data-store",
      "ti-container",
      "semi-supervised",
      "time-series",
      "unsupervised",
    ] as const) {
      expect(getService(kind).formComponent).not.toBeNull();
    }
  });

  it("every default entry exposes a labelKey resolvable in both locales", () => {
    // Registry entries are non-UI metadata: `label` is an English
    // diagnostics string, and the actual UI label is owned by the
    // `nodes.serviceLabels.*` i18n namespace. This test pins the
    // contract so a future refactor cannot silently drop `labelKey`
    // (and force consumers back to the English `label`).
    const enLabels = (
      enMessages as { nodes: { serviceLabels: Record<string, string> } }
    ).nodes.serviceLabels;
    const koLabels = (
      koMessages as { nodes: { serviceLabels: Record<string, string> } }
    ).nodes.serviceLabels;
    for (const entry of listServices()) {
      expect(entry.labelKey).toBe(entry.kind);
      expect(enLabels[entry.labelKey]).toBeTruthy();
      expect(koLabels[entry.labelKey]).toBeTruthy();
    }
  });

  it("adding a hypothetical seventh service requires only one registerService call", () => {
    // Pin the contract from issue #315: a genuinely new service
    // drops in with a single `registerService(...)` call against an
    // arbitrary string `kind` and the base props bag — no edits to
    // the typed `ServiceKind` union or `ServiceFormPropsMap`, no
    // edits to any consumer (dialog layer, Draft tab, diagnostics).
    // Extending the typed union / props map is offered as an
    // optional guardrail for callers that want narrowed types, not
    // as a precondition to register.
    //
    // Round 9 → 17 history: prior versions of this test either cast
    // a synthetic kind to `never` (false-green for "any string kind
    // works") or re-registered an existing real kind (did not
    // exercise extensibility at all). This version registers a
    // genuinely novel `kind` against the runtime surface and asserts
    // it is visible to `listServices()` and `getService(...)`.
    resetRegistry();
    expect(listServices().length).toBe(0);
    const hypotheticalModule: ServiceFormModule<{ port: number }> = {
      defaults: () => ({ port: 9000 }),
      serialise: () => "",
      deserialise: () => ({ port: 9000 }),
    };
    registerService({
      kind: "hypothetical-7",
      label: "Hypothetical 7",
      serviceKey: "hypothetical-7",
      mode: "configure-here",
      module: hypotheticalModule,
    });
    expect(listServices().map((e) => e.kind)).toEqual(["hypothetical-7"]);
    const entry = getService("hypothetical-7");
    expect(entry.serviceKey).toBe("hypothetical-7");
    expect(entry.mode).toBe("configure-here");
    expect(entry.labelKey).toBe("hypothetical-7");
    expect(entry.formComponent).toBeNull();
    // Restore the autoloaded default set for sibling tests.
    return import("@/lib/node/service-registry").then((m) => {
      m.resetRegistry();
      m.registerDefaultServices();
    });
  });
});
