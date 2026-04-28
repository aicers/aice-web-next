/**
 * Shared types and constants for the per-service form modules under
 * `src/lib/node/services/`.
 *
 * Field constants mirror the names used in `decisions/node-field-catalog.md`.
 */

export const GIGANTO_INGEST_PORT = 38370;
export const GIGANTO_PUBLISH_PORT = 38371;
export const GRAPHQL_PORT = 8443;
export const PORT_TIVAN_DEFAULT = 8444;
export const ACK_TRANSMISSION = 1024;
export const RETENTION_PERIOD = 100;
export const MAX_LEVEL_BASE = 512;
export const MAX_SUBCOMPACTION = 2;
export const THREAD_COUNT = 8;
export const MAX_OPEN_FILES = 8000;
export const MAX_PCAP_SIZE = 1000;
export const NODE_NAME_MAX_LENGTH = 32;
export const NODE_DESCRIPTION_MAX_LENGTH = 64;
export const NODE_HOSTNAME_MAX_LENGTH = 64;

export const PORT_HTTP_80 = 80;
export const PORT_HTTP_8000 = 8000;
export const PORT_HTTP_8080 = 8080;
export const PORT_HTTPS = 443;
export const PORT_SSH = 22;
export const PORT_FTP = 21;

export const STANDARD_PORTS: Record<
  "http" | "https" | "ftp" | "ssh",
  readonly number[]
> = {
  http: [PORT_HTTP_80, PORT_HTTP_8000, PORT_HTTP_8080],
  https: [PORT_HTTPS],
  ftp: [PORT_FTP],
  ssh: [PORT_SSH],
};

/**
 * Context the dialog passes alongside form values when serialising.
 * Modules ignore the bag if they do not need it; Hog uses
 * `activeSensorsPool` to apply the all-checked → None rule for
 * `active_sensors`, since the actual sensor-id set is only known to
 * the rendering layer. Set-equality between the selected ids and the
 * pool ids is the right test — counting alone would silently broaden
 * a draft when the pool changed between hydrate and save.
 */
export interface SerialiseContext {
  activeSensorsPool?: readonly string[];
}

/**
 * Context the dialog passes alongside the wire payload when hydrating
 * a draft back into form state. Mirrors {@link SerialiseContext} for
 * Hog's asymmetric `active_sensors` rule: a missing `active_sensors`
 * key on the wire means "every sensor selected", but the deserialiser
 * can only expand that to the full id list if the rendering layer
 * passes the current sensor pool. Both pool fields also drive the
 * stale-id filter on hydrate — wire values that no longer appear in
 * the current pool are dropped so the form never carries invisible
 * state the operator cannot see or clear (e.g. a non-gs model wire
 * value reopened under `NEXT_PUBLIC_GS_MODE=1`).
 */
export interface DeserialiseContext {
  /** Ordered sensor ids currently in the rendering pool. */
  sensorPool?: readonly string[];
  /**
   * Current model wire-value pool the form will render. Defaults to
   * the live `ACTIVE_MODELS` set when the caller omits it. Used to
   * filter unsupported wire values out of `models` on hydrate so a
   * draft saved under one `NEXT_PUBLIC_GS_MODE` cannot smuggle hidden
   * non-gs / removed entries into a different build.
   */
  activeModelsPool?: readonly string[];
}

/**
 * Context the dialog passes when seeding default form state for a
 * brand-new draft (no `initial` payload). Mirrors the deserialise
 * shape: a brand-new Hog draft must default `sensors` to the full
 * rendered pool so the create path matches the same module's
 * "missing key on the wire = all selected" hydrate semantics. Without
 * this, a brand-new draft serialises with `active_sensors = []`
 * (zero selected) even though omission and zero are *not*
 * interchangeable on the wire.
 */
export interface DefaultsContext {
  /** Ordered sensor ids currently in the rendering pool. */
  sensorPool?: readonly string[];
  /**
   * Current model wire-value pool. Defaults to the live
   * `ACTIVE_MODELS` set when omitted.
   */
  activeModelsPool?: readonly string[];
}

/**
 * Per-service form module contract. Every form component is paired
 * with one of these so the registry can drive default-state /
 * serialisation / deserialisation generically.
 */
export interface ServiceFormModule<TValues> {
  defaults: (initial?: TValues | null, context?: DefaultsContext) => TValues;
  serialise: (values: TValues, context?: SerialiseContext) => string;
  deserialise: (toml: string, context?: DeserialiseContext) => TValues;
}
