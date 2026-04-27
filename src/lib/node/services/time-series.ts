import { z } from "zod";

import { formatSocketAddr, parseSocketAddr } from "../socket-addr";
import { fromToml, type TomlEntries, toToml } from "../toml";
import {
  ipAddressSchema,
  nodeHostnameOptionalSchema,
  portSchema,
} from "../validation";
import {
  GIGANTO_INGEST_PORT,
  GIGANTO_PUBLISH_PORT,
  type ServiceFormModule,
} from "./types";

/**
 * Crusher (Time Series Generator) configuration form. Both ingest and
 * publish addresses share the same IP — the form collects it once and
 * the serialiser duplicates it.
 *
 * Authoritative spec: `decisions/node-field-catalog.md` ("Crusher").
 */

export const TIME_SERIES_HARDCODED = {
  lastTimestampData: "/opt/clumit/var/time_series_generator/time_data.json",
  logPath: "/opt/clumit/log/time_series_generator.log",
} as const;

export interface TimeSeriesFormValues {
  dataStoreIp: string;
  dataStoreHostname: string;
  receivePort: number;
  sendPort: number;
}

export const timeSeriesFormSchema = z.object({
  dataStoreIp: ipAddressSchema,
  // `giganto_name` is `Option<string>` for Crusher; an empty value
  // serialises as an absent key.
  dataStoreHostname: nodeHostnameOptionalSchema(),
  receivePort: portSchema,
  sendPort: portSchema,
});

export function defaultTimeSeriesValues(
  initial?: TimeSeriesFormValues | null,
): TimeSeriesFormValues {
  if (initial) return { ...initial };
  return {
    dataStoreIp: "",
    dataStoreHostname: "",
    receivePort: GIGANTO_INGEST_PORT,
    sendPort: GIGANTO_PUBLISH_PORT,
  };
}

export function serialiseTimeSeries(values: TimeSeriesFormValues): string {
  const hostname = values.dataStoreHostname.trim();
  // Key order mirrors aice-web's `CrusherConfig` struct declaration
  // order at commit `71c4623…` (see `tools/draft-capture/`).
  const entries: TomlEntries = [
    // `giganto_name` is `Option<string>`; omit the key when blank so
    // upstream drafts that never set a hostname round-trip unchanged.
    ["giganto_name", hostname.length === 0 ? null : hostname],
    [
      "giganto_ingest_srv_addr",
      formatSocketAddr(values.dataStoreIp, values.receivePort),
    ],
    [
      "giganto_publish_srv_addr",
      formatSocketAddr(values.dataStoreIp, values.sendPort),
    ],
    ["last_timestamp_data", TIME_SERIES_HARDCODED.lastTimestampData],
    ["log_path", TIME_SERIES_HARDCODED.logPath],
  ];
  return toToml(entries);
}

export function deserialiseTimeSeries(toml: string): TimeSeriesFormValues {
  const raw = fromToml(toml);
  const { ip: ingestIp, port: ingestPort } = parseSocketAddr(
    (raw.giganto_ingest_srv_addr ?? "") as string,
    GIGANTO_INGEST_PORT,
  );
  const { port: publishPort } = parseSocketAddr(
    (raw.giganto_publish_srv_addr ?? "") as string,
    GIGANTO_PUBLISH_PORT,
  );
  return {
    dataStoreIp: ingestIp,
    dataStoreHostname: (raw.giganto_name ?? "") as string,
    receivePort: ingestPort,
    sendPort: publishPort,
  };
}

export const timeSeriesModule: ServiceFormModule<TimeSeriesFormValues> = {
  defaults: defaultTimeSeriesValues,
  serialise: serialiseTimeSeries,
  deserialise: deserialiseTimeSeries,
};
