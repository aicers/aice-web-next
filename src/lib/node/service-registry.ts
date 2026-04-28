import type { ComponentType } from "react";

import { DataStoreForm } from "@/components/node/forms/data-store-form";
import { SemiSupervisedForm } from "@/components/node/forms/semi-supervised-form";
import { SensorForm } from "@/components/node/forms/sensor-form";
import { TiContainerForm } from "@/components/node/forms/ti-container-form";
import { TimeSeriesForm } from "@/components/node/forms/time-series-form";
import { UnsupervisedEnginePanel } from "@/components/node/forms/unsupervised-engine-panel";

import type { SensorNodeOption } from "./sensor-list";
import { dataStoreModule } from "./services/data-store";
import { semiSupervisedModule } from "./services/semi-supervised";
import { sensorModule } from "./services/sensor";
import { tiContainerModule } from "./services/ti-container";
import { timeSeriesModule } from "./services/time-series";
import type { ServiceFormModule } from "./services/types";
import { unsupervisedModule } from "./services/unsupervised";

/**
 * Source-of-truth registry for the per-service configuration forms.
 *
 * **Adding a new service requires only a single `registerService(...)`
 * call.** The registration surface accepts any string `kind` and the
 * base prop bag (`{ disabled?: boolean }`) by default, so a hypothetical
 * seventh service drops in with one entry — no consumer code edits, no
 * dialog-layer or Draft-tab plumbing changes, and no required edits to
 * the typed `ServiceKind` union or `ServiceFormPropsMap`.
 *
 * `ServiceKind` and `ServiceFormPropsMap` exist as **optional** type-level
 * guardrails for callers that want narrowed types: extending the union
 * lets `getService("known-kind")` return a typed entry, and adding to the
 * props map lets the dialog pass strongly-typed bespoke props (Hog's
 * `sensorOptions`, for example) without an `any` cast. Skipping those
 * edits is fine — the new entry is fully visible to `listServices()` and
 * `getService(...)` either way.
 *
 * The acceptance test in `src/__tests__/lib/node/service-registry.test.ts`
 * pins that no other consumer (dialog layer, Draft tab, diagnostics)
 * needs editing — `getService(kind).formComponent` is the single runtime
 * surface the rest of the app reads from.
 *
 * **Localization contract.** Registry entries are non-UI metadata; the
 * `label` field is an English string for diagnostics and logs only.
 * UI consumers (the create/edit dialog accordion in Phase Node-4 and
 * the detail-page Draft tab in Phase Node-5) must render the service
 * label by feeding `labelKey` to
 * `useTranslations("nodes.serviceLabels")`, which resolves against the
 * `nodes.serviceLabels.*` namespace in `src/i18n/messages/{en,ko}.json`.
 * Pulling `entry.label` straight into the UI would reintroduce English
 * service names in the Korean locale.
 */

/**
 * Configuration entry-point this service exposes in the create/edit
 * dialog. Phase Detection-22 defines two flavours — `configure-here`
 * (the form in this sub-issue) and `configure-manually` (a free-form
 * TOML editor that ships out-of-band) — and a service may support
 * either one or both of them. The registry needs to distinguish all
 * three because the dialog renders different UI per cell.
 *
 * `mode` and `formComponent` work together; one rule covers all three
 * cases:
 *
 * **`formComponent` is the per-service component the dialog renders
 * inside that service's accordion body.** What it represents depends
 * on `mode`:
 *
 * - `configure-here`: `formComponent` is the data-bound form. The
 *   dialog renders only the form — no toggle, no manual editor.
 * - `configure-manually`: `formComponent` is an informational panel
 *   (no inputs, no form state). The dialog renders the manual editor;
 *   when `formComponent` is non-null it is rendered alongside the
 *   editor (e.g. an REconverge note above the TOML pane). Unsupervised
 *   Engine ships such a panel; for any other manual-only service that
 *   has nothing to show, `formComponent` may be omitted (registers as
 *   `null`).
 * - `both`: a Configure-Here / Configure-Manually toggle gates the
 *   data-bound `formComponent` (form) vs the manual editor.
 *
 * The same `formComponent` slot covers data-bound forms and
 * informational panels — generic consumers read `mode` to decide
 * whether the rendered component is interactive (configure-here /
 * both) or read-only (configure-manually). This keeps the registry
 * with one component slot per service rather than two parallel ones,
 * and keeps Phase Node-4/5 from special-casing Unsupervised Engine.
 *
 * Collapsing `mode` down to a `supportsManualMode: boolean` would lose
 * the distinction between "configure-here only" (Data Store / TI
 * Container) and "configure-manually only" (Unsupervised Engine), so
 * a generic consumer such as the dialog accordion could not tell them
 * apart. The catalog mapping is pinned in
 * `decisions/node-field-catalog.md` (see the per-service "Configure
 * Manually" notes).
 */
export type ServiceMode = "configure-here" | "configure-manually" | "both";

export type ServiceKind =
  | "sensor"
  | "data-store"
  | "ti-container"
  | "semi-supervised"
  | "time-series"
  | "unsupervised";

/**
 * Minimum prop contract every per-service form component must accept.
 * Unknown / hypothetical kinds (anything outside the typed
 * `ServiceKind` union) get this bag automatically — the registry never
 * forces a new service to extend the typed map just to register.
 */
export interface BaseServiceFormProps {
  disabled?: boolean;
}

/**
 * Optional prop-bag overrides for known kinds. Most services only need
 * `disabled`; Hog (semi-supervised) additionally needs the sensor pool
 * from `listSensorNodes()`. Adding an entry here is what lets the
 * dialog pass strongly-typed bespoke props without an `any` cast — it
 * is *not* required to register a new service. A new kind that only
 * needs the base contract drops in with a single
 * `registerService(...)` call.
 */
export interface ServiceFormPropsMap {
  sensor: BaseServiceFormProps;
  "data-store": BaseServiceFormProps;
  "ti-container": BaseServiceFormProps;
  "semi-supervised": BaseServiceFormProps & {
    sensorOptions: readonly SensorNodeOption[];
  };
  "time-series": BaseServiceFormProps;
  unsupervised: BaseServiceFormProps;
}

/**
 * Resolves the prop bag for a registered kind: known kinds in the
 * typed map get their bespoke shape, anything else falls back to
 * {@link BaseServiceFormProps}.
 */
export type ServiceFormProps<K extends string> =
  K extends keyof ServiceFormPropsMap
    ? ServiceFormPropsMap[K]
    : BaseServiceFormProps;

export type ServiceFormComponent<K extends string> = ComponentType<
  ServiceFormProps<K>
>;

export interface ServiceRegistryEntry<
  K extends string = ServiceKind,
  TValues = unknown,
> {
  /** UI label as shown in the create/edit dialog accordion. */
  kind: K;
  /**
   * Non-UI English label. Use only for diagnostics, logs, and error
   * messages — never as user-visible copy. UI consumers (the create/edit
   * dialog and detail-page Draft tab) must render `labelKey` through
   * `useTranslations("nodes.serviceLabels")` so the localized node UI
   * stays locale-clean. The string is kept in code so a registry entry
   * is still readable when an exception surfaces without an i18n
   * context (e.g. server logs).
   */
  label: string;
  /**
   * `next-intl` key under `nodes.serviceLabels.*`. UI callers resolve
   * this with `useTranslations("nodes.serviceLabels")(entry.labelKey)`.
   * Defaults to `kind` when `registerService` is called without an
   * override.
   */
  labelKey: string;
  /** Stable agent / external service `key` (matches `node-field-catalog.md`). */
  serviceKey: string;
  /**
   * Configuration entry-point(s) this service exposes — see
   * {@link ServiceMode}. The dialog accordion reads this to decide
   * whether to render a Configure-Here / Configure-Manually toggle
   * (`"both"`), only the form (`"configure-here"`), or only the
   * manual editor (`"configure-manually"`). Replaces the prior
   * `supportsManualMode: boolean` shape, which conflated
   * "configure-here only" with "configure-manually only".
   */
  mode: ServiceMode;
  /**
   * Per-service component the dialog renders inside this service's
   * accordion body. Interpreted against {@link ServiceMode}:
   * `configure-here` / `both` → data-bound form;
   * `configure-manually` → informational panel rendered alongside the
   * manual editor (or `null` when the service has nothing extra to
   * show). See {@link ServiceMode} for the full rule.
   */
  formComponent: ServiceFormComponent<K> | null;
  /** Pure module that owns defaults / serialise / deserialise. */
  module: ServiceFormModule<TValues>;
}

export interface ServiceRegistryDefinition<
  K extends string = ServiceKind,
  TValues = unknown,
> extends Omit<ServiceRegistryEntry<K, TValues>, "formComponent" | "labelKey"> {
  formComponent?: ServiceRegistryEntry<K, TValues>["formComponent"];
  labelKey?: ServiceRegistryEntry<K, TValues>["labelKey"];
}

type AnyServiceEntry = ServiceRegistryEntry<string, unknown>;

const REGISTRY: AnyServiceEntry[] = [];

export function registerService<K extends string, TValues>(
  entry: ServiceRegistryDefinition<K, TValues>,
): void {
  if (REGISTRY.some((e) => e.kind === entry.kind)) {
    throw new Error(`Service ${entry.kind} already registered`);
  }
  REGISTRY.push({
    ...entry,
    formComponent: entry.formComponent ?? null,
    labelKey: entry.labelKey ?? entry.kind,
  } as unknown as AnyServiceEntry);
}

export function listServices(): readonly AnyServiceEntry[] {
  return REGISTRY;
}

export function getService<K extends ServiceKind>(
  kind: K,
): ServiceRegistryEntry<K, unknown>;
export function getService(kind: string): ServiceRegistryEntry<string, unknown>;
export function getService(
  kind: string,
): ServiceRegistryEntry<string, unknown> {
  const entry = REGISTRY.find((e) => e.kind === kind);
  if (!entry) throw new Error(`Service ${kind} is not registered`);
  return entry;
}

/** Reset for tests. */
export function resetRegistry(): void {
  REGISTRY.length = 0;
}

/** Form-component overrides keyed per service kind, all optional. */
export type ServiceFormComponentOverrides = {
  [K in ServiceKind]?: ServiceFormComponent<K>;
};

/**
 * Default registry initialiser. Call once at module load (or under
 * tests after `resetRegistry()`) to populate the six services this
 * sub-issue ships. Each entry carries the actual rendered component;
 * `formComponents` overrides are kept for tests that want to swap a
 * simpler stand-in.
 */
export function registerDefaultServices(
  formComponents: ServiceFormComponentOverrides = {},
): void {
  registerService({
    kind: "sensor",
    label: "Sensor",
    serviceKey: "piglet",
    mode: "both",
    module: sensorModule,
    formComponent: formComponents.sensor ?? SensorForm,
  });
  registerService({
    kind: "data-store",
    label: "Data Store",
    serviceKey: "giganto",
    mode: "configure-here",
    module: dataStoreModule,
    formComponent: formComponents["data-store"] ?? DataStoreForm,
  });
  registerService({
    kind: "ti-container",
    label: "TI Container",
    serviceKey: "tivan",
    mode: "configure-here",
    module: tiContainerModule,
    formComponent: formComponents["ti-container"] ?? TiContainerForm,
  });
  registerService({
    kind: "semi-supervised",
    label: "Semi-supervised Engine",
    serviceKey: "hog",
    mode: "both",
    module: semiSupervisedModule,
    formComponent: formComponents["semi-supervised"] ?? SemiSupervisedForm,
  });
  registerService({
    kind: "time-series",
    label: "Time Series Generator",
    serviceKey: "crusher",
    mode: "both",
    module: timeSeriesModule,
    formComponent: formComponents["time-series"] ?? TimeSeriesForm,
  });
  registerService({
    kind: "unsupervised",
    label: "Unsupervised Engine",
    serviceKey: "reconverge",
    mode: "configure-manually",
    module: unsupervisedModule,
    formComponent: formComponents.unsupervised ?? UnsupervisedEnginePanel,
  });
}

// Auto-register the default set on first import. Tests that assert
// registry behaviour reset and re-populate as needed.
registerDefaultServices();
