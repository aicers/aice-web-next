import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DUMP_HTTP_CONTENT_TYPES,
  DUMP_ITEMS,
  defaultSensorValues,
  deserialiseSensor,
  PROTOCOLS_FOR_PIGLET,
  type SensorFormValues,
  sensorFormSchema,
  serialiseSensor,
} from "@/lib/node/services/sensor";

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

function baseValues(): SensorFormValues {
  return {
    ...defaultSensorValues(),
    dataStoreIp: "10.0.0.1",
    dataStoreHostname: "data-store-1",
    dataStorePort: 38370,
    pciBusAddresses: ["0000:00:1f.6"],
    // The catalog preset for `dump_items` is just `Pcap` (one of four)
    // — the tests for the all-checked / partial / zero-selected wire
    // cases set this explicitly per case rather than rely on defaults.
    dumpItems: [...DUMP_ITEMS],
  };
}

describe("Sensor (Piglet) form", () => {
  it("hydrates from defaults and round-trips through TOML — all checked", () => {
    const values = baseValues();
    const toml = serialiseSensor(values);
    expect(toml).toBe(fixture("sensor-all-checked.toml"));
    const round = deserialiseSensor(toml);
    expect(round).toEqual(values);
  });

  it("emits explicit empty arrays for the zero-selected case", () => {
    const values: SensorFormValues = {
      ...baseValues(),
      protocols: [],
      dumpItems: [],
      dumpHttpContentTypes: [],
    };
    const toml = serialiseSensor(values);
    expect(toml).toBe(fixture("sensor-zero-selected.toml"));
    const round = deserialiseSensor(toml);
    expect(round).toEqual(values);
  });

  it("clears dump_http_content_types when dumpItems no longer includes http", () => {
    // Regression guard: hidden form-state must not leak. Start from
    // the partial case (http selected with two content types), then
    // uncheck HTTP. The UI removes the nested checkbox group but the
    // form value remains; the serialiser must reset to [] so a stale
    // ["pdf", "txt"] is not preserved on the wire.
    const values: SensorFormValues = {
      ...baseValues(),
      dumpItems: ["pcap"],
      dumpHttpContentTypes: ["pdf", "txt"],
    };
    const toml = serialiseSensor(values);
    expect(toml).toMatch(/dump_http_content_types\s*=\s*\[\s*\]/);
    expect(toml).not.toContain('"pdf"');
    expect(toml).not.toContain('"txt"');
  });

  it("does not collapse Piglet checklists to None when entries duplicate", () => {
    // The shared `normaliseChecklist` helper used to compare
    // `selected.length === total`. A draft with `protocols` cloned to
    // 15 entries (one duplicated, one missing) would silently broaden
    // to "all checked" on the next save. The same hole applies to
    // `dump_items` / `dump_http_content_types`. Pin all three: the
    // deduplicated valid set must equal the full pool, and partial
    // sets — even those whose raw length matches — emit an explicit
    // subset.
    const values: SensorFormValues = {
      ...baseValues(),
      // Duplicate "bootp", drop "ssh" — raw length is still 15.
      protocols: [
        "bootp",
        "bootp",
        "conn",
        "dns",
        "ftp",
        "http",
        "https",
        "kerberos",
        "ldap",
        "mqtt",
        "nfs",
        "radius",
        "rdp",
        "smb",
        "smtp",
      ],
      // Duplicate "pcap", drop "http" — raw length is still 4.
      dumpItems: ["pcap", "pcap", "eml", "ftp"],
      dumpHttpContentTypes: ["office", "office", "exe", "pdf", "txt"],
    };
    const toml = serialiseSensor(values);
    expect(toml).toMatch(/protocols\s*=\s*\[/);
    expect(toml).not.toContain('"ssh"');
    expect(toml).toMatch(/dump_items\s*=\s*\[/);
    expect(toml).not.toMatch(/dump_items\s*=\s*\[\s*\]/);
    // Note: `dump_http_content_types` is gated by `dumpItems` containing
    // "http"; here it does not, so the wire emits `[]` per the
    // hidden-state guard. The protocols / dump_items duplicates are the
    // ones the raw-length check missed.
  });

  it("emits the strict subset for the partial case", () => {
    const values: SensorFormValues = {
      ...baseValues(),
      protocols: ["http", "ssh"],
      dumpItems: ["pcap", "http"],
      dumpHttpContentTypes: ["pdf", "txt"],
    };
    const toml = serialiseSensor(values);
    expect(toml).toBe(fixture("sensor-partial.toml"));
    const round = deserialiseSensor(toml);
    expect(round).toEqual(values);
  });

  it("ships the 15 ProtocolForPiglet variants in the catalog order", () => {
    expect([...PROTOCOLS_FOR_PIGLET]).toEqual([
      "bootp",
      "conn",
      "dns",
      "ftp",
      "http",
      "https",
      "kerberos",
      "ldap",
      "mqtt",
      "nfs",
      "radius",
      "rdp",
      "smb",
      "smtp",
      "ssh",
    ]);
  });

  it("ships the documented dump-item and dump-http-content-type sets", () => {
    expect([...DUMP_ITEMS]).toEqual(["pcap", "eml", "ftp", "http"]);
    expect([...DUMP_HTTP_CONTENT_TYPES]).toEqual([
      "office",
      "exe",
      "pdf",
      "txt",
      "vbs",
    ]);
  });

  it("repairs missing standard ports during deserialisation", () => {
    // Regression guard for the Round 13 review: if a wire payload
    // somehow lacks a pinned standard port, the deserialiser merges it
    // back in so the form value matches the chip-rendering invariant.
    // The repair lives in `withStandardPorts`, not in a mount-time
    // `useEffect`, so a hydrated form is never dirtied silently on
    // first render.
    const values: SensorFormValues = {
      ...baseValues(),
      ftpPorts: [2121],
      httpPorts: [9000],
      httpsPorts: [9443],
      sshPorts: [2222],
    };
    const wire = serialiseSensor(values).replace(
      /ftp_ports = \[21, 2121\]/,
      "ftp_ports = [2121]",
    );
    const round = deserialiseSensor(wire);
    expect(round.ftpPorts).toEqual([21, 2121]);
  });

  it("repairs missing standard ports when seeding from an initial value", () => {
    const partial: SensorFormValues = {
      ...baseValues(),
      ftpPorts: [2121],
      httpPorts: [9000],
      httpsPorts: [],
      sshPorts: [2222],
    };
    const seeded = defaultSensorValues(partial);
    expect(seeded.ftpPorts).toEqual([21, 2121]);
    expect(seeded.httpPorts).toEqual([80, 8000, 8080, 9000]);
    expect(seeded.httpsPorts).toEqual([443]);
    expect(seeded.sshPorts).toEqual([22, 2222]);
  });

  it("surfaces required validation errors on a fresh form", () => {
    const empty = defaultSensorValues();
    const issues = sensorFormSchema.safeParse(empty);
    expect(issues.success).toBe(false);
    if (!issues.success) {
      const paths = issues.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("dataStoreIp");
      expect(paths).toContain("dataStoreHostname");
      expect(paths).toContain("pciBusAddresses");
    }
  });
});
