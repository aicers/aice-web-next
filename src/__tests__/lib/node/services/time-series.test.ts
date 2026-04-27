import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultTimeSeriesValues,
  deserialiseTimeSeries,
  serialiseTimeSeries,
  timeSeriesFormSchema,
} from "@/lib/node/services/time-series";

const FIXTURE = path.join(
  process.cwd(),
  "src",
  "__tests__",
  "lib",
  "node",
  "fixtures",
  "time-series.toml",
);

describe("Time Series (Crusher) form", () => {
  it("duplicates the IP into ingest + publish addresses on the wire", () => {
    const values = {
      ...defaultTimeSeriesValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "data-store-1",
    };
    const toml = serialiseTimeSeries(values);
    expect(toml).toBe(readFileSync(FIXTURE, "utf8"));
    expect(deserialiseTimeSeries(toml)).toEqual(values);
  });

  it("requires the IP but not the hostname (Option<string>)", () => {
    // Catalog: `giganto_name` is `Option<string>` — leaving it blank
    // is valid and serialises as an absent key.
    const issues = timeSeriesFormSchema.safeParse(defaultTimeSeriesValues());
    expect(issues.success).toBe(false);
    const ipOnly = timeSeriesFormSchema.safeParse({
      ...defaultTimeSeriesValues(),
      dataStoreIp: "10.0.0.1",
    });
    expect(ipOnly.success).toBe(true);
  });

  it("omits giganto_name when the hostname is blank", () => {
    const toml = serialiseTimeSeries({
      ...defaultTimeSeriesValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "",
    });
    expect(toml).not.toContain("giganto_name");
    // A draft with no hostname must round-trip back to an empty value.
    const round = deserialiseTimeSeries(toml);
    expect(round.dataStoreHostname).toBe("");
  });
});
