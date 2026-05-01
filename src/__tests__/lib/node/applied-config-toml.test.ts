/**
 * Coverage for `applied-config-toml.ts`. The Settings page projects
 * applied external configs (returned by Giganto / Tivan as structured
 * objects) into the flat TOML wire format the per-service form
 * `deserialise` consumes, so the Edit dialog can seed an external with
 * `draft: null` from the actual applied state. These tests pin the
 * projection so a future Giganto/Tivan schema field added on the
 * server side cannot silently start dropping into the dialog seed
 * with the wrong key or shape.
 */
import { describe, expect, it } from "vitest";

import {
  gigantoConfigToToml,
  tivanConfigToToml,
} from "@/lib/node/applied-config-toml";
import { fromToml } from "@/lib/node/toml";
import type { GigantoConfig, TivanConfig } from "@/lib/node/types";

describe("gigantoConfigToToml", () => {
  it("projects every field the Data Store deserialiser reads", () => {
    const config: GigantoConfig = {
      ingestSrvAddr: "10.0.0.1:38370",
      publishSrvAddr: "10.0.0.1:38371",
      graphqlSrvAddr: "10.0.0.1:8443",
      retention: "30d",
      exportDir: "/opt/clumit/var/data_store/export",
      dataDir: "/opt/clumit/var/data_store",
      maxOpenFiles: 8000,
      // GigantoConfig types these as strings even though the wire is
      // an integer literal. The projection must coerce so the form
      // deserialiser sees a number.
      maxMbOfLevelBase: "512",
      numOfThread: 8,
      maxSubcompactions: "2",
      ackTransmission: 1024,
    };
    const toml = gigantoConfigToToml(config);
    const parsed = fromToml(toml);
    expect(parsed.ingest_srv_addr).toBe("10.0.0.1:38370");
    expect(parsed.publish_srv_addr).toBe("10.0.0.1:38371");
    expect(parsed.graphql_srv_addr).toBe("10.0.0.1:8443");
    expect(parsed.retention).toBe("30d");
    expect(parsed.data_dir).toBe("/opt/clumit/var/data_store");
    expect(parsed.export_dir).toBe("/opt/clumit/var/data_store/export");
    expect(parsed.max_open_files).toBe(8000);
    expect(parsed.max_mb_of_level_base).toBe(512);
    expect(parsed.num_of_thread).toBe(8);
    expect(parsed.max_subcompactions).toBe(2);
    expect(parsed.ack_transmission).toBe(1024);
  });

  it("normalizes hour-based Giganto retention into the dialog's supported day unit", () => {
    const config: GigantoConfig = {
      ingestSrvAddr: "10.0.0.1:38370",
      publishSrvAddr: "10.0.0.1:38371",
      graphqlSrvAddr: "10.0.0.1:8443",
      retention: "168h",
      exportDir: "/opt/clumit/var/data_store/export",
      dataDir: "/opt/clumit/var/data_store",
      maxOpenFiles: 8000,
      maxMbOfLevelBase: "512",
      numOfThread: 8,
      maxSubcompactions: "2",
      ackTransmission: 1024,
    };
    const toml = gigantoConfigToToml(config);
    const parsed = fromToml(toml);
    expect(parsed.retention).toBe("7d");
  });
});

describe("tivanConfigToToml", () => {
  it("projects graphql_srv_addr (the only field the TI Container deserialiser reads)", () => {
    const config: TivanConfig = {
      graphqlSrvAddr: "10.0.0.2:8444",
      translateMitre: "/opt/clumit/share/ti_container/translation_mitre.json",
      excelData: null,
      originMitre: null,
    };
    const toml = tivanConfigToToml(config);
    const parsed = fromToml(toml);
    expect(parsed.graphql_srv_addr).toBe("10.0.0.2:8444");
  });
});
