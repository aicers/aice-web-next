import { z } from "zod";

import { ACTIVE_MODELS, GS_MODE } from "../active-models";
import { formatSocketAddr, parseSocketAddr } from "../socket-addr";
import { fromToml, type TomlEntries, toToml } from "../toml";
import {
  ipAddressSchema,
  nodeHostnameSchema,
  noLeadingTrailingWhitespace,
  portSchema,
} from "../validation";
import { hydrateChecklist, normaliseChecklist } from "./empty-list";
import {
  type DefaultsContext,
  type DeserialiseContext,
  GIGANTO_PUBLISH_PORT,
  type ServiceFormModule,
} from "./types";

/**
 * Hog (Semi-supervised Engine) configuration form.
 *
 * Authoritative spec: `decisions/node-field-catalog.md` ("Hog").
 */

export const PROTOCOLS_FOR_HOG = [
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
] as const;
export type ProtocolForHog = (typeof PROTOCOLS_FOR_HOG)[number];

export const HOG_HARDCODED = {
  cryptocurrencyMiningPool:
    "/opt/clumit/share/semi_supervised/cryptocurrency.json",
  logPath: "/opt/clumit/log/semi_supervised.log",
  exportDir: "/opt/clumit/var/semi_supervised/export",
  modelDir: "/opt/clumit/var/semi_supervised/models",
  servicesPath: "/opt/clumit/var/semi_supervised/services",
} as const;

export interface SemiSupervisedFormValues {
  dataStoreIp: string;
  dataStoreHostname: string;
  dataStorePort: number;
  protocols: ProtocolForHog[];
  /** TOML wire values (e.g. "dns covert channel"). */
  models: string[];
  /** Sensor node ids selected from `listSensorNodes()`. */
  sensors: string[];
}

export const semiSupervisedFormSchema = z.object({
  dataStoreIp: ipAddressSchema,
  dataStoreHostname: nodeHostnameSchema(),
  dataStorePort: portSchema,
  protocols: z.array(z.enum(PROTOCOLS_FOR_HOG)),
  models: z.array(z.string().refine(noLeadingTrailingWhitespace)),
  sensors: z.array(z.string().refine(noLeadingTrailingWhitespace)),
});

export function defaultSemiSupervisedValues(
  initial?: SemiSupervisedFormValues | null,
  context?: DefaultsContext,
): SemiSupervisedFormValues {
  if (initial) return { ...initial };
  // Sensors default to the full rendered pool so the create path
  // matches the deserialise rule: a missing `active_sensors` key on
  // the wire means "all selected", and the brand-new draft's
  // first save must round-trip with that meaning. Defaulting to `[]`
  // would emit `active_sensors = []` (zero selected) — every sensor
  // unchecked — which is the opposite intent for a new Hog draft.
  // Callers that don't yet know the pool (e.g. the standalone test
  // harness) get `[]`; the dialog (Phase Node-4) is responsible for
  // passing the pool once it has resolved `listSensorNodes()`.
  const sensors = context?.sensorPool ? [...context.sensorPool] : [];
  const modelsPool =
    context?.activeModelsPool ?? ACTIVE_MODELS.map((m) => m.wire);
  return {
    dataStoreIp: "",
    dataStoreHostname: "",
    dataStorePort: GIGANTO_PUBLISH_PORT,
    protocols: [...PROTOCOLS_FOR_HOG],
    models: [...modelsPool],
    sensors,
  };
}

/**
 * Apply the asymmetric all-checked rule to a wire-keyed checklist
 * (`active_sensors`, `active_models`) against the current pool.
 * Returns `undefined` (i.e. omit the key → `None`) only when the
 * **deduplicated valid** selections exactly match the pool as a set —
 * never on count alone. This protects against two failure modes that a
 * raw-length check would silently miss:
 *
 *   1. Stale values in form state (e.g. a sensor that has rotated out
 *      after a hydrate, or a model dropped by a `NEXT_PUBLIC_GS_MODE`
 *      flip) — those would otherwise pass the count check and broaden
 *      the draft to "all current pool members".
 *   2. Duplicate values from a malformed wire draft (e.g. the manual
 *      TOML path) — `["sensor-a", "sensor-a"]` against pool
 *      `["sensor-a", "sensor-b"]` has matching length and every entry
 *      is in the pool, but is really a single-id subset.
 */
function normaliseAgainstPool(
  selected: readonly string[],
  pool: readonly string[] | undefined,
): string[] | undefined {
  if (pool === undefined) return [...selected];
  const poolSet = new Set(pool);
  const validUnique = new Set<string>();
  for (const id of selected) {
    if (poolSet.has(id)) validUnique.add(id);
  }
  if (validUnique.size === poolSet.size) return undefined;
  return [...selected];
}

export interface SerialiseSemiSupervisedOptions {
  /**
   * Current sensor-id pool the form was rendered with — required to
   * apply the asymmetric "all checked → None" rule to `active_sensors`
   * correctly. The all-checked test is set-equality between the
   * selected ids and the pool ids; counting alone would silently
   * broaden a draft when the pool changed between hydrate and save.
   * Callers that don't know the pool (e.g. tests that don't care
   * about all-checked semantics) may omit it; the serialiser then
   * falls back to "no normalisation other than zero-vs-non-zero".
   */
  activeSensorsPool?: readonly string[];
  /**
   * Current model wire-value pool the form was rendered with. Same
   * reasoning as `activeSensorsPool`: `ACTIVE_MODELS` is dynamic
   * (toggled by `NEXT_PUBLIC_GS_MODE`, extensible over time), so a
   * stale model still selected in form state must not collapse to
   * "all" just because the count happens to match. Defaults to the
   * current `ACTIVE_MODELS` set when the caller omits it.
   */
  activeModelsPool?: readonly string[];
  forceGsRewrite?: boolean;
}

export function serialiseSemiSupervised(
  values: SemiSupervisedFormValues,
  options: SerialiseSemiSupervisedOptions = {},
): string {
  const protocols = normaliseChecklist(values.protocols, PROTOCOLS_FOR_HOG);
  const modelsPool =
    options.activeModelsPool ?? ACTIVE_MODELS.map((m) => m.wire);
  let models = normaliseAgainstPool(values.models, modelsPool);
  // The gs build rewrites a `None` (all checked) `active_models` back
  // to `Some([])`, mirroring aice-web's `fetch.rs` behaviour for the
  // `gs` cargo feature. This rewrite has no inverse on the wire — in
  // gs mode `active_models = []` truly cannot distinguish "all
  // checked" from "zero selected" — so the deserialiser hydrates
  // `[]` symmetrically as zero-selected. The all-checked case is the
  // intrinsically lossy direction in gs mode; the operator must
  // re-check the boxes after a save+reopen if they want everything on.
  if ((options.forceGsRewrite ?? GS_MODE) && models === undefined) {
    models = [];
  }
  const sensors = normaliseAgainstPool(
    values.sensors,
    options.activeSensorsPool,
  );
  // Key order mirrors aice-web's `HogConfig` struct declaration order
  // at commit `71c4623…` — `active_protocols` / `active_sensors` /
  // `active_models` come first, ahead of the giganto + hardcoded
  // fields. See `tools/draft-capture/` for the reference generator.
  const entries: TomlEntries = [
    ["active_protocols", protocols],
    ["active_sensors", sensors],
    ["active_models", models],
    ["giganto_name", values.dataStoreHostname],
    [
      "giganto_publish_srv_addr",
      formatSocketAddr(values.dataStoreIp, values.dataStorePort),
    ],
    ["cryptocurrency_mining_pool", HOG_HARDCODED.cryptocurrencyMiningPool],
    ["log_path", HOG_HARDCODED.logPath],
    ["export_dir", HOG_HARDCODED.exportDir],
    ["model_dir", HOG_HARDCODED.modelDir],
    ["services_path", HOG_HARDCODED.servicesPath],
  ];
  return toToml(entries);
}

export type DeserialiseSemiSupervisedOptions = DeserialiseContext;

export function deserialiseSemiSupervised(
  toml: string,
  context: DeserialiseSemiSupervisedOptions = {},
): SemiSupervisedFormValues {
  const raw = fromToml(toml);
  const { ip, port } = parseSocketAddr(
    (raw.giganto_publish_srv_addr ?? "") as string,
    GIGANTO_PUBLISH_PORT,
  );
  const protocols = raw.active_protocols as
    | readonly ProtocolForHog[]
    | undefined;
  const rawModels = raw.active_models as readonly string[] | undefined;
  const rawSensors = raw.active_sensors as readonly string[] | undefined;
  const modelPool =
    context.activeModelsPool ?? ACTIVE_MODELS.map((m) => m.wire);
  const modelPoolSet = new Set(modelPool);
  // Symmetric hydration of the wire-side rule: `[]` always means "zero
  // selected", regardless of gs mode. The gs build's serialise step
  // rewrites the all-checked `None` to `Some([])` for byte-compat with
  // aice-web's `fetch.rs`, but that rewrite has no inverse — the wire
  // truly cannot distinguish all-checked from zero-selected in gs
  // mode. We pick the catalog's symmetric semantics here so a user
  // who saves zero models reopens with zero models; the all-checked
  // case is intrinsically lossy in gs mode and the operator must
  // re-check the boxes after a save+reopen if they want them all on.
  // We also intersect with the current model pool to drop wire values
  // that no longer exist in this build (e.g. a non-gs-only model wire
  // value reopened under `NEXT_PUBLIC_GS_MODE=1`); without the
  // filter, the form would carry invisible state the operator cannot
  // see or clear and the next save would re-emit the unsupported
  // value unchanged.
  const models = hydrateChecklist(rawModels, modelPool).filter((wire) =>
    modelPoolSet.has(wire),
  );
  // Asymmetric all-checked rule: a missing `active_sensors` key means
  // "every sensor selected" on the wire. We can only expand that to
  // the full id list if the caller passed the current sensor pool;
  // without it, fall back to an empty list (callers that don't have a
  // pool yet must re-hydrate once it is available). When a pool is
  // provided we additionally intersect with it so a sensor that has
  // since rotated out of the rendering set cannot linger as hidden
  // state in form values.
  const sensorPool = context.sensorPool;
  let sensors: string[];
  if (rawSensors === undefined) {
    sensors = sensorPool ? [...sensorPool] : [];
  } else if (sensorPool) {
    const sensorPoolSet = new Set(sensorPool);
    sensors = [...rawSensors].filter((id) => sensorPoolSet.has(id));
  } else {
    sensors = [...rawSensors];
  }
  return {
    dataStoreIp: ip,
    dataStoreHostname: (raw.giganto_name ?? "") as string,
    dataStorePort: port,
    protocols: hydrateChecklist(protocols, PROTOCOLS_FOR_HOG),
    models,
    sensors,
  };
}

export const semiSupervisedModule: ServiceFormModule<SemiSupervisedFormValues> =
  {
    defaults: (initial, ctx) => defaultSemiSupervisedValues(initial, ctx),
    serialise: (v, ctx) =>
      serialiseSemiSupervised(v, {
        activeSensorsPool: ctx?.activeSensorsPool,
      }),
    deserialise: (toml, ctx) => deserialiseSemiSupervised(toml, ctx),
  };
