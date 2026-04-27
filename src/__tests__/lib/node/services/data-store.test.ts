import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  dataStoreFormSchema,
  defaultDataStoreValues,
  deserialiseDataStore,
  serialiseDataStore,
} from "@/lib/node/services/data-store";

const FIXTURE = path.join(
  process.cwd(),
  "src",
  "__tests__",
  "lib",
  "node",
  "fixtures",
  "data-store.toml",
);

describe("Data Store (Giganto) form", () => {
  it("serialises defaults to the pinned TOML and round-trips back", () => {
    const values = {
      ...defaultDataStoreValues(),
      receiveIp: "10.0.0.1",
      sendIp: "10.0.0.1",
      webIp: "10.0.0.1",
    };
    const toml = serialiseDataStore(values);
    expect(toml).toBe(readFileSync(FIXTURE, "utf8"));
    const round = deserialiseDataStore(toml);
    expect(round).toEqual(values);
  });

  it("emits retention as humantime suffixed value", () => {
    const values = {
      ...defaultDataStoreValues(),
      receiveIp: "1.1.1.1",
      sendIp: "1.1.1.1",
      webIp: "1.1.1.1",
      retention: { value: 4, unit: "w" } as const,
    };
    const toml = serialiseDataStore(values);
    expect(toml).toContain('retention = "4w"');
  });

  it("brackets IPv6 endpoints on the wire and round-trips back", () => {
    const values = {
      ...defaultDataStoreValues(),
      receiveIp: "2001:db8::1",
      sendIp: "::1",
      webIp: "fe80::1",
    };
    const toml = serialiseDataStore(values);
    expect(toml).toContain('ingest_srv_addr = "[2001:db8::1]:38370"');
    expect(toml).toContain('publish_srv_addr = "[::1]:38371"');
    expect(toml).toContain('graphql_srv_addr = "[fe80::1]:8443"');
    expect(deserialiseDataStore(toml)).toEqual(values);
  });

  it("accepts IPv6 literals in the form schema", () => {
    const result = dataStoreFormSchema.safeParse({
      ...defaultDataStoreValues(),
      receiveIp: "::1",
      sendIp: "2001:db8::1",
      webIp: "10.0.0.1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty IP fields via the form schema", () => {
    const issues = dataStoreFormSchema.safeParse(defaultDataStoreValues());
    expect(issues.success).toBe(false);
    if (!issues.success) {
      const paths = issues.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("receiveIp");
      expect(paths).toContain("sendIp");
      expect(paths).toContain("webIp");
    }
  });
});
