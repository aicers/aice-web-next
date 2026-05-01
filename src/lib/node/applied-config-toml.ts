import "server-only";

import { type TomlEntries, toToml } from "./toml";
import type { GigantoConfig, TivanConfig } from "./types";

function normalizeGigantoRetention(retention: string): string {
  const hours = /^(\d+)h$/.exec(retention);
  if (!hours) return retention;
  const totalHours = Number(hours[1]);
  if (Number.isFinite(totalHours) && totalHours % 24 === 0) {
    return `${totalHours / 24}d`;
  }
  return retention;
}

/**
 * Convert a structured `GigantoConfig` (Giganto's `config` GraphQL
 * query) into the flat TOML wire shape the Data Store form's
 * `deserialise` consumes. The Edit dialog seeds external services from
 * the same TOML format `draft` uses on the node payload, so the
 * applied config has to be projected into TOML before it can act as
 * a drop-in seed.
 *
 * Without this projection the dialog would fall back to blank-IP
 * defaults whenever a node hosts Data Store with `draft: null`, and
 * the dialog schema's `superRefine` IP validation would then block
 * any save — including a metadata-only edit that never opened the
 * external accordion.
 *
 * `maxMbOfLevelBase` and `maxSubcompactions` arrive as strings on
 * `GigantoConfig` but are integer literals on the wire, mirroring
 * what `deserialiseDataStore` expects.
 */
export function gigantoConfigToToml(config: GigantoConfig): string {
  const entries: TomlEntries = [
    ["ingest_srv_addr", config.ingestSrvAddr],
    ["publish_srv_addr", config.publishSrvAddr],
    ["graphql_srv_addr", config.graphqlSrvAddr],
    ["retention", normalizeGigantoRetention(config.retention)],
    ["data_dir", config.dataDir],
    ["export_dir", config.exportDir],
    ["max_open_files", config.maxOpenFiles],
    ["max_mb_of_level_base", Number(config.maxMbOfLevelBase)],
    ["num_of_thread", config.numOfThread],
    ["max_subcompactions", Number(config.maxSubcompactions)],
    ["ack_transmission", config.ackTransmission],
  ];
  return toToml(entries);
}

/**
 * Project a structured `TivanConfig` into the flat TOML the TI
 * Container form's `deserialise` consumes. Only `graphql_srv_addr` is
 * read by the deserialiser today; the other fields are hard-coded by
 * the TOML emitter, so we project just the address here to avoid
 * inventing TOML keys the form never reads.
 */
export function tivanConfigToToml(config: TivanConfig): string {
  const entries: TomlEntries = [["graphql_srv_addr", config.graphqlSrvAddr]];
  return toToml(entries);
}
