import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultSemiSupervisedValues,
  deserialiseSemiSupervised,
  PROTOCOLS_FOR_HOG,
  type ProtocolForHog,
  type SemiSupervisedFormValues,
  semiSupervisedModule,
  serialiseSemiSupervised,
} from "@/lib/node/services/semi-supervised";

const FIXTURE_DIR = path.join(
  process.cwd(),
  "src",
  "__tests__",
  "lib",
  "node",
  "fixtures",
);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

function baseValues(): SemiSupervisedFormValues {
  return {
    ...defaultSemiSupervisedValues(),
    dataStoreIp: "10.0.0.1",
    dataStoreHostname: "data-store-1",
    dataStorePort: 38371,
  };
}

describe("Semi-supervised (Hog) form", () => {
  it("declares the 18 ProtocolForHog variants in catalog order", () => {
    expect([...PROTOCOLS_FOR_HOG]).toEqual([
      "bootp",
      "conn",
      "dns",
      "dhcp",
      "rdp",
      "http",
      "smtp",
      "ntlm",
      "kerberos",
      "ssh",
      "dce_rpc",
      "ftp",
      "mqtt",
      "ldap",
      "radius",
      "tls",
      "smb",
      "nfs",
    ]);
    expect(PROTOCOLS_FOR_HOG.length).toBe(18);
  });

  it("emits None for protocols, models, and sensors when all are checked", () => {
    // The pinned "all checked" fixture omits every list field subject
    // to the asymmetric rule. Sensors require the actual pool ids
    // because the rendering layer is the only place that knows what
    // "all sensors" means at this moment.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a", "sensor-b"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeSensorsPool: ["sensor-a", "sensor-b"],
    });
    expect(toml).toBe(fixture("hog-all-checked.toml"));
  });

  it("round-trips an all-checked draft back to the full sensor pool", () => {
    // A draft produced by aice-web with `active_sensors` omitted must
    // hydrate as "every sensor selected" so re-saving does not silently
    // flip semantics from `None` (all) to `Some([])` (none).
    const sensorPool = ["sensor-a", "sensor-b"];
    const toml = serialiseSemiSupervised(
      { ...baseValues(), sensors: sensorPool },
      { activeSensorsPool: sensorPool },
    );
    expect(toml).not.toContain("active_sensors");
    const round = deserialiseSemiSupervised(toml, { sensorPool });
    expect(round.sensors).toEqual(sensorPool);
  });

  it("emits Some([subset]) for active_sensors when partial vs pool", () => {
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeSensorsPool: ["sensor-a", "sensor-b"],
    });
    expect(toml).toContain('active_sensors = ["sensor-a"]');
  });

  it("does not collapse to None when selected ids drift from the pool", () => {
    // Regression guard: count alone is not enough. If the form state
    // still carries a stale id while the pool has rotated to a new
    // sensor, the selected.length === pool.length condition would
    // erroneously fire, silently broadening the draft to "all current
    // sensors". The rule must be set-equality between selected ids
    // and pool ids — emit the actual subset whenever they diverge.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a", "sensor-old"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeSensorsPool: ["sensor-a", "sensor-new"],
    });
    expect(toml).toContain('active_sensors = ["sensor-a", "sensor-old"]');
    expect(toml).not.toMatch(/active_sensors\s*=\s*\[\s*\]/);
  });

  it("serialise keeps Some([subset]) when active_models drifts from the pool (defense in depth)", () => {
    // Same stale-hidden-value problem as `active_sensors`, but for
    // `active_models`. The primary defense is the deserialise filter
    // (see "deserialise drops..."), which prevents stale ids from
    // ever entering form state on hydrate. This test pins the
    // serialise side as a defense-in-depth check: if a stale id
    // somehow reaches form state through a non-deserialise path, the
    // rule must keep the explicit Some([subset]) shape — never
    // collapse to "all checked" just because the count happens to
    // match.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      models: ["dns covert channel", "stale removed model"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeModelsPool: ["dns covert channel", "tor connection"],
    });
    expect(toml).toContain(
      'active_models = ["dns covert channel", "stale removed model"]',
    );
    expect(toml).not.toMatch(/active_models\s*=\s*\[\s*\]/);
  });

  it("deserialise drops models not in the current pool", () => {
    // Cross-mode hygiene: a draft that contains a non-gs-only model
    // (e.g. "rdp brute force") reopened under a pool that does not
    // include it must not carry that wire value forward as invisible
    // state. The form does not render a checkbox for it, so the
    // operator cannot see or clear it; without the filter, the next
    // save would re-emit the unsupported value unchanged.
    const toml = [
      'giganto_publish_srv_addr = "10.0.0.1:38371"',
      'giganto_name = "data-store-1"',
      'cryptocurrency_mining_pool = "/opt/clumit/share/semi_supervised/cryptocurrency.json"',
      'log_path = "/opt/clumit/log/semi_supervised.log"',
      'export_dir = "/opt/clumit/var/semi_supervised/export"',
      'model_dir = "/opt/clumit/var/semi_supervised/models"',
      'services_path = "/opt/clumit/var/semi_supervised/services"',
      'active_models = ["dns covert channel", "rdp brute force"]',
      "",
    ].join("\n");
    const round = deserialiseSemiSupervised(toml, {
      activeModelsPool: ["dns covert channel", "tor connection"],
    });
    expect(round.models).toEqual(["dns covert channel"]);
    expect(round.models).not.toContain("rdp brute force");
  });

  it("deserialise drops sensors not in the rendering pool", () => {
    // Same hygiene as models: a sensor id that has rotated out of the
    // current `listSensorNodes()` result is hidden in the UI, so it
    // must be filtered out on hydrate so the next save does not
    // silently re-emit it.
    const toml = [
      'giganto_publish_srv_addr = "10.0.0.1:38371"',
      'giganto_name = "data-store-1"',
      'cryptocurrency_mining_pool = "/opt/clumit/share/semi_supervised/cryptocurrency.json"',
      'log_path = "/opt/clumit/log/semi_supervised.log"',
      'export_dir = "/opt/clumit/var/semi_supervised/export"',
      'model_dir = "/opt/clumit/var/semi_supervised/models"',
      'services_path = "/opt/clumit/var/semi_supervised/services"',
      'active_sensors = ["sensor-a", "sensor-old"]',
      "",
    ].join("\n");
    const round = deserialiseSemiSupervised(toml, {
      sensorPool: ["sensor-a", "sensor-new"],
    });
    expect(round.sensors).toEqual(["sensor-a"]);
    expect(round.sensors).not.toContain("sensor-old");
  });

  it("does not collapse to None when active_sensors contains duplicates", () => {
    // A malformed draft from the manual TOML path can deliver
    // `["sensor-a", "sensor-a"]` against a real two-sensor pool. The
    // raw-length check would treat that as "all checked" (length 2 ===
    // pool size 2, every entry in the pool), silently broadening the
    // next save to include `sensor-b`. The rule is set-equality on the
    // deduplicated valid selections — emit the explicit subset.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a", "sensor-a"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeSensorsPool: ["sensor-a", "sensor-b"],
    });
    expect(toml).toContain('active_sensors = ["sensor-a", "sensor-a"]');
    expect(toml).not.toMatch(/active_sensors\s*=\s*\[\s*\]/);
  });

  it("does not collapse to None when active_models contains duplicates", () => {
    // Same shape as the active_sensors duplicate guard, but for
    // models. Defense in depth against malformed drafts that clone an
    // entry instead of including a real second one.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      models: ["dns covert channel", "dns covert channel"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeModelsPool: ["dns covert channel", "tor connection"],
    });
    expect(toml).toContain(
      'active_models = ["dns covert channel", "dns covert channel"]',
    );
    expect(toml).not.toMatch(/active_models\s*=\s*\[\s*\]/);
  });

  it("does not collapse to None when active_protocols contains duplicates", () => {
    // `normaliseChecklist` (used for active_protocols) had the same
    // raw-length bug as `normaliseAgainstPool`. A malformed wire draft
    // with one duplicate and one missing protocol must not be treated
    // as "all checked"; the deduplicated valid set has 17 entries, the
    // pool has 18, so emit the explicit subset.
    const duplicated: ProtocolForHog[] = [
      "bootp",
      "bootp",
      "conn",
      "dns",
      "dhcp",
      "rdp",
      "http",
      "smtp",
      "ntlm",
      "kerberos",
      "ssh",
      "dce_rpc",
      "ftp",
      "mqtt",
      "ldap",
      "radius",
      "tls",
      "smb",
      // 18 entries with one duplicate ("bootp") and "nfs" missing.
    ];
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      protocols: duplicated,
    };
    const toml = serialiseSemiSupervised(values);
    expect(toml).toMatch(/active_protocols\s*=\s*\[/);
    expect(toml).not.toContain('"nfs"');
  });

  it("emits explicit empty arrays for the zero-selected case", () => {
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      protocols: [],
      models: [],
      sensors: [],
    };
    const toml = serialiseSemiSupervised(values);
    expect(toml).toBe(fixture("hog-zero-selected.toml"));
  });

  it("emits the strict subset for the partial case", () => {
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      protocols: ["http", "ssh", "tls"],
      models: ["dns covert channel", "tor connection"],
      sensors: ["sensor-a", "sensor-b"],
    };
    const toml = serialiseSemiSupervised(values);
    expect(toml).toBe(fixture("hog-partial.toml"));
    const round = deserialiseSemiSupervised(toml);
    expect(round.protocols).toEqual(values.protocols);
    expect(round.models).toEqual(values.models);
    expect(round.sensors).toEqual(values.sensors);
  });

  it("registry serialise threads activeSensorsPool through to the rule", () => {
    // The registry-wrapped serialise must not silently drop the
    // sensor pool; otherwise the all-checked → None rule never fires
    // for callers that go through the module rather than the direct
    // function.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a", "sensor-b"],
    };
    const allChecked = semiSupervisedModule.serialise(values, {
      activeSensorsPool: ["sensor-a", "sensor-b"],
    });
    expect(allChecked).not.toContain("active_sensors");
    const partial = semiSupervisedModule.serialise(
      { ...values, sensors: ["sensor-a"] },
      { activeSensorsPool: ["sensor-a", "sensor-b"] },
    );
    expect(partial).toContain('active_sensors = ["sensor-a"]');
  });

  it("gs-mode rewrite turns all-checked models into Some([])", () => {
    const values = baseValues();
    const toml = serialiseSemiSupervised(values, { forceGsRewrite: true });
    expect(toml).toContain("active_models = []");
  });

  it("gs-mode all-checked output is byte-identical to the captured Rust fixture", () => {
    // Pins the gs-only wire shape against aice-web at commit `71c4623`:
    // a `None` (all checked) `active_models` is rewritten to
    // `Some(Vec::new())` by `fetch.rs`, so the wire emits
    // `active_models = []` while `active_protocols` and
    // `active_sensors` stay omitted. Without this fixture the only
    // gs-rewrite coverage is a substring assertion against this
    // emitter's own output — the contract that aice-web-next is
    // interchangeable with aice-web in gs builds was unverified.
    const values: SemiSupervisedFormValues = {
      ...baseValues(),
      sensors: ["sensor-a", "sensor-b"],
    };
    const toml = serialiseSemiSupervised(values, {
      activeSensorsPool: ["sensor-a", "sensor-b"],
      forceGsRewrite: true,
    });
    expect(toml).toBe(fixture("hog-all-checked-gs.toml"));
  });

  it("brand-new defaults seed sensors from the rendered pool", () => {
    // A brand-new Hog draft must round-trip as "all sensors selected"
    // — i.e. the dialog should serialise it with `active_sensors`
    // omitted, which the deserialiser hydrates back to the full pool.
    // Without seeding, the create path emits `active_sensors = []`
    // (zero selected) on first save: the opposite intent for a
    // freshly-opened form. Pin the seeding here so a regression that
    // strips the pool wiring fails this test.
    const sensorPool = ["sensor-a", "sensor-b", "sensor-c"];
    const seeded = defaultSemiSupervisedValues(null, { sensorPool });
    expect(seeded.sensors).toEqual(sensorPool);
    const toml = serialiseSemiSupervised(
      { ...seeded, dataStoreIp: "10.0.0.1", dataStoreHostname: "hog-1" },
      { activeSensorsPool: sensorPool },
    );
    expect(toml).not.toContain("active_sensors");
  });

  it("brand-new defaults still return [] when no pool is supplied", () => {
    // The standalone test harness (and any caller that has not yet
    // resolved `listSensorNodes()`) keeps the existing behaviour: an
    // empty list. The dialog is the layer that owns the pool wiring
    // — see the Author Round 12 disposition for why this is the
    // right boundary.
    const seeded = defaultSemiSupervisedValues();
    expect(seeded.sensors).toEqual([]);
  });

  it("brand-new defaults seed models from a pool override when supplied", () => {
    const modelsPool = ["custom model"];
    const seeded = defaultSemiSupervisedValues(null, {
      activeModelsPool: modelsPool,
    });
    expect(seeded.models).toEqual(modelsPool);
  });

  it("registry defaults thread the sensor pool through to the seed", () => {
    const sensorPool = ["sensor-a", "sensor-b"];
    const seeded = semiSupervisedModule.defaults(null, { sensorPool });
    expect(seeded.sensors).toEqual(sensorPool);
  });

  it("hydrates Some([]) active_models as zero selected in every mode", () => {
    // Symmetric wire rule per the catalog: `[]` on the wire always
    // means "zero models selected", and only an omitted key means
    // "all checked". The gs build's serialise rewrite (None → []) has
    // no inverse on the wire; hydrating `[]` as the full pool would
    // silently flip a zero-selected save into "all checked" on
    // reopen, which is the bigger correctness regression. The
    // deliberate trade-off is that gs mode genuinely cannot express
    // "all checked" round-trippably — the operator must re-check the
    // boxes after a save+reopen if they want the all-on state. Pin
    // the zero-selected direction here so a user who clears every
    // model reopens with zero models, regardless of build flavour.
    const tomlGs = serialiseSemiSupervised(
      { ...baseValues(), models: [] },
      { forceGsRewrite: true },
    );
    const tomlStd = serialiseSemiSupervised(
      { ...baseValues(), models: [] },
      { forceGsRewrite: false },
    );
    expect(deserialiseSemiSupervised(tomlGs).models).toEqual([]);
    expect(deserialiseSemiSupervised(tomlStd).models).toEqual([]);
  });
});
