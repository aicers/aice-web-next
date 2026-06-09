import { describe, expect, it } from "vitest";

import type { ScalarKind } from "@/lib/event";
import {
  RECORD_DESCRIPTORS,
  RECORD_TYPE_IDS,
  recordFamily,
  STRING_NUMBER_KINDS,
  SUB_RECORD_FIELDS,
} from "@/lib/event";
import type { RawEventFieldValue } from "@/lib/event/types";

import { RAW_EVENT_SAMPLES } from "../../fixtures/external/giganto/raw-events-samples";

/**
 * Parametrized coverage for all 34 Giganto record types — 20 network
 * plus 14 sysmon / endpoint. The `.graphql` documents are validated
 * against the SDL by the schema-validation gate, but the hand-written
 * `types.ts` and the descriptor scalar tables are not — so this
 * fixture-driven test asserts, per type, that:
 *
 *   - the descriptor describes exactly the fields the record carries
 *     (no missing field, no stray key);
 *   - every field's serialized value matches its declared scalar kind —
 *     critically, all four `StringNumber*` kinds (U64 / I64 / Usize /
 *     U32) are typed as `string`, never a JS number;
 *   - the curated table columns reference real fields; and
 *   - the family-appropriate common header is present — the network
 *     header (minus ports for Icmp), or the sysmon header (no ports at
 *     all).
 */

/**
 * The 10 network header fields every network type carries; ports are
 * added when present.
 */
const HEADER_FIELDS = [
  "time",
  "origAddr",
  "respAddr",
  "proto",
  "startTime",
  "duration",
  "origPkts",
  "respPkts",
  "origL2Bytes",
  "respL2Bytes",
] as const;
const PORT_FIELDS = ["origPort", "respPort"] as const;

/** The 7 header fields every sysmon type carries (no ports). */
const SYSMON_HEADER_FIELDS = [
  "time",
  "agentName",
  "agentId",
  "processGuid",
  "processId",
  "image",
  "user",
] as const;

/** Assert a serialized value matches its descriptor scalar kind. */
function assertScalar(value: RawEventFieldValue, scalar: ScalarKind): void {
  switch (scalar) {
    // All four StringNumber variants plus the plain string scalars are
    // serialized as `string`.
    case "string":
    case "datetime":
    case "u64":
    case "i64":
    case "u32":
    case "usize":
      expect(typeof value).toBe("string");
      break;
    case "int":
      expect(typeof value).toBe("number");
      break;
    case "bool":
      expect(typeof value).toBe("boolean");
      break;
    case "stringList":
      expect(Array.isArray(value)).toBe(true);
      for (const item of value as unknown[]) expect(typeof item).toBe("string");
      break;
    case "intList":
      expect(Array.isArray(value)).toBe(true);
      for (const item of value as unknown[]) expect(typeof item).toBe("number");
      break;
    case "intMatrix":
      expect(Array.isArray(value)).toBe(true);
      for (const row of value as unknown[]) {
        expect(Array.isArray(row)).toBe(true);
        for (const item of row as unknown[]) expect(typeof item).toBe("number");
      }
      break;
    case "sub:dceRpcContext":
    case "sub:ftpCommand":
    case "sub:dhcpOption":
      expect(Array.isArray(value)).toBe(true);
      for (const item of value as unknown[]) {
        expect(typeof item).toBe("object");
        expect(item).not.toBeNull();
      }
      break;
    default: {
      // Exhaustiveness guard: a new scalar kind must extend this switch.
      const never: never = scalar;
      throw new Error(`unhandled scalar kind: ${String(never)}`);
    }
  }
}

describe("RECORD_DESCRIPTORS registry", () => {
  it("covers exactly the 34 record types", () => {
    expect(RECORD_TYPE_IDS.length).toBe(34);
    expect(Object.keys(RECORD_DESCRIPTORS).sort()).toEqual(
      [...RECORD_TYPE_IDS].sort(),
    );
  });

  it("exercises every StringNumber* variant somewhere in the surface", () => {
    const seen = new Set<ScalarKind>();
    for (const id of RECORD_TYPE_IDS) {
      for (const field of RECORD_DESCRIPTORS[id].fields) {
        if (STRING_NUMBER_KINDS.has(field.scalar)) seen.add(field.scalar);
      }
    }
    // E0 only had U64/I64; E1 adds Usize (Http) and U32 (Dhcp/Bootp/…).
    expect(seen).toEqual(new Set(["u64", "i64", "u32", "usize"]));
  });
});

describe.each(RECORD_TYPE_IDS)("%s record type", (id) => {
  const descriptor = RECORD_DESCRIPTORS[id];
  const family = recordFamily(id);
  const sample = RAW_EVENT_SAMPLES[id] as unknown as Record<
    string,
    RawEventFieldValue
  >;
  const fieldKeys = descriptor.fields.map((f) => f.key);

  it("identifies itself and its query response key", () => {
    expect(descriptor.id).toBe(id);
    // The query-name suffix differs per family: network types end in
    // `RawEvents`, sysmon types in `Events`.
    const suffix = family === "sysmon" ? "Events" : "RawEvents";
    expect(descriptor.responseKey).toBe(`${id}${suffix}`);
  });

  it("describes exactly the fields the record carries", () => {
    expect(new Set(fieldKeys)).toEqual(new Set(Object.keys(sample)));
    // No duplicate field descriptors.
    expect(fieldKeys.length).toBe(new Set(fieldKeys).size);
  });

  it("carries its family's common header", () => {
    if (family === "sysmon") {
      // Sysmon types share the agent/process header and carry no ports.
      for (const key of SYSMON_HEADER_FIELDS) expect(fieldKeys).toContain(key);
      expect(descriptor.hasPorts).toBe(false);
      for (const key of PORT_FIELDS) expect(fieldKeys).not.toContain(key);
      return;
    }
    // Network types share the IP/proto header; ports are present for all
    // but Icmp.
    for (const key of HEADER_FIELDS) expect(fieldKeys).toContain(key);
    expect(descriptor.hasPorts).toBe(id !== "icmp");
    for (const key of PORT_FIELDS) {
      if (descriptor.hasPorts) expect(fieldKeys).toContain(key);
      else expect(fieldKeys).not.toContain(key);
    }
  });

  it("curates table columns from real fields", () => {
    expect(descriptor.summaryKeys.length).toBeGreaterThan(0);
    for (const key of descriptor.summaryKeys) expect(fieldKeys).toContain(key);
  });

  it("types every field value per its scalar kind", () => {
    for (const field of descriptor.fields) {
      assertScalar(sample[field.key], field.scalar);
    }
  });

  it("types every StringNumber* field as string", () => {
    for (const field of descriptor.fields) {
      if (STRING_NUMBER_KINDS.has(field.scalar)) {
        expect(typeof sample[field.key]).toBe("string");
      }
    }
  });
});

describe("sub-record descriptors", () => {
  it("types nested sub-record fields, including StringNumber*", () => {
    // FtpCommand.fileSize is a StringNumberU64 inside a sub-record, so
    // assert sub-record scalars hold too — exercised via the FTP sample.
    const ftp = RAW_EVENT_SAMPLES.ftp;
    for (const command of ftp.commands) {
      const row = command as unknown as Record<string, RawEventFieldValue>;
      for (const field of SUB_RECORD_FIELDS.ftpCommand) {
        assertScalar(row[field.key], field.scalar);
      }
      expect(typeof command.fileSize).toBe("string");
    }
  });

  it("describes DCE/RPC contexts and DHCP options against their samples", () => {
    const dceRpc = RAW_EVENT_SAMPLES.dceRpc;
    for (const ctx of dceRpc.context) {
      const row = ctx as unknown as Record<string, RawEventFieldValue>;
      for (const field of SUB_RECORD_FIELDS.dceRpcContext) {
        assertScalar(row[field.key], field.scalar);
      }
    }
    const dhcp = RAW_EVENT_SAMPLES.dhcp;
    for (const option of dhcp.options) {
      const row = option as unknown as Record<string, RawEventFieldValue>;
      for (const field of SUB_RECORD_FIELDS.dhcpOption) {
        assertScalar(row[field.key], field.scalar);
      }
    }
  });
});

describe("MalformedDns mapping (not Dns-shaped)", () => {
  const fields = new Map(
    RECORD_DESCRIPTORS.malformedDns.fields.map((f) => [f.key, f]),
  );

  it("has no Dns-only query/answer/rcode fields", () => {
    expect(fields.has("query")).toBe(false);
    expect(fields.has("answer")).toBe(false);
    expect(fields.has("rcode")).toBe(false);
  });

  it("keeps byte/count payload scalars as string", () => {
    const sample = RAW_EVENT_SAMPLES.malformedDns;
    expect(typeof sample.queryBytes).toBe("string");
    expect(typeof sample.respBytes).toBe("string");
    expect(typeof sample.queryCount).toBe("string");
    expect(typeof sample.respCount).toBe("string");
    // Raw payloads are arrays of byte arrays.
    expect(Array.isArray(sample.queryBody)).toBe(true);
    expect(Array.isArray(sample.queryBody[0])).toBe(true);
  });
});
