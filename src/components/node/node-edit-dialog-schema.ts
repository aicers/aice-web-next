import { z } from "zod";

import {
  EXTERNAL_KIND_BY_REGISTRY_KIND,
  isExternalRegistryKind,
  PREFIX_BY_REGISTRY_KIND,
} from "@/components/node/node-edit-dialog-state";
import { buildNodeMetadataSchema } from "@/lib/node/node-metadata-schema";
import { listServices } from "@/lib/node/service-registry";
import { dataStoreFormSchema } from "@/lib/node/services/data-store";
import { semiSupervisedFormSchema } from "@/lib/node/services/semi-supervised";
import { sensorFormSchema } from "@/lib/node/services/sensor";
import { tiContainerFormSchema } from "@/lib/node/services/ti-container";
import { timeSeriesFormSchema } from "@/lib/node/services/time-series";
import type { Node as ManagerNode } from "@/lib/node/types";
import type { NodeValidationMessages } from "@/lib/node/validation";

/**
 * Per-service form schemas keyed by registry kind. Used by
 * {@link buildDialogSchema}'s `superRefine` to validate every enabled +
 * Configure-Here service before the dialog dispatches the save — a
 * blank Configure-Here form must surface inline errors instead of
 * silently posting an empty draft. Unsupervised Engine has no fields
 * and is intentionally absent.
 */
export const SERVICE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  sensor: sensorFormSchema,
  "data-store": dataStoreFormSchema,
  "ti-container": tiContainerFormSchema,
  "semi-supervised": semiSupervisedFormSchema,
  "time-series": timeSeriesFormSchema,
};

interface MembershipMap {
  [kind: string]: {
    enabled: boolean;
    configMode: "configure-here" | "configure-manually";
  };
}

/**
 * Compose the dialog schema from `nodeMetadataSchema`, the membership
 * map, and every per-service form schema reachable through the
 * registry. `superRefine` runs each per-service schema **only** when
 * the service is enabled and in Configure-Here mode, so a Manually-mode
 * or disabled service contributes no validation noise.
 *
 * `loose()` preserves the per-service value bags under their canonical
 * camelCase prefixes (e.g. `sensor`, `dataStore`); without it the
 * Zod parse strips them and the post-validation `onValid` path could
 * not serialise per-service drafts. The `superRefine` pushes any
 * sub-issues back up under `<prefix>.<field>` so RHF surfaces them on
 * the per-service form input that owns the field.
 *
 * Externals (Data Store / TI Container) carry only `draft` on the node
 * payload — applied config lives on Giganto / Tivan and is fetched
 * separately by the Settings page. When that fetch is transiently
 * unavailable (`ExternalServiceUnavailableError` swallowed), the
 * external section opens with blank-IP registry defaults. In that
 * "no baseline" case we skip the per-service IP validation **only
 * while the user has not touched the section** — so a metadata-only
 * edit can still save (`buildDraftSubmission` preserves the original
 * `draft: null` on the wire) but the moment the user starts editing
 * the blank-default fields the live IP rules fire again, instead of
 * silently letting an invalid draft round-trip to the wire. The
 * `isExternalSectionTouched` callback is invoked at parse time and
 * reads RHF's current `dirtyFields` snapshot, so the schema does not
 * need to be rebuilt on every keystroke.
 */
export function buildDialogSchema(args: {
  mode: "create" | "edit";
  node: ManagerNode | null | undefined;
  appliedExternalDrafts: Readonly<Record<string, string>>;
  /**
   * Returns true when the user has touched the per-service form bag or
   * the membership entry for `kind` since the dialog opened. Defaults
   * to "untouched" when omitted (test convenience). The fallback skip
   * only applies when this returns false — once the user touches the
   * section, the per-service IP rules run as normal.
   */
  isExternalSectionTouched?: (kind: string) => boolean;
  /**
   * Locale-aware messages for the metadata form's schema-level errors.
   * Threaded down from the dialog's `useTranslations` call so the
   * inline error path renders in the active locale instead of the
   * historic English literals. Omitting this keeps the English
   * defaults (used by tests and any non-dialog import path).
   */
  metadataMessages?: NodeValidationMessages;
}): z.ZodTypeAny {
  const {
    mode,
    node,
    appliedExternalDrafts,
    isExternalSectionTouched,
    metadataMessages,
  } = args;
  return z
    .object({
      metadata: buildNodeMetadataSchema(metadataMessages),
      membership: z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          configMode: z.enum(["configure-here", "configure-manually"]),
        }),
      ),
    })
    .loose()
    .superRefine((data, ctx) => {
      const membership = (data as { membership?: MembershipMap }).membership;
      if (!membership) return;
      for (const entry of listServices()) {
        const state = membership[entry.kind];
        if (!state?.enabled) continue;
        const isManual =
          entry.mode === "configure-manually" ||
          state.configMode === "configure-manually";
        if (isManual) continue;
        const schema = SERVICE_SCHEMAS[entry.kind];
        if (!schema) continue;
        const prefix = PREFIX_BY_REGISTRY_KIND[entry.kind];
        if (!prefix) continue;
        if (
          mode === "edit" &&
          isExternalRegistryKind(entry.kind) &&
          !appliedExternalDrafts[entry.kind]
        ) {
          const extKind = EXTERNAL_KIND_BY_REGISTRY_KIND[entry.kind];
          const original = node?.externalServices.find(
            (e) => e.kind === extKind,
          );
          // Form opened from blank-IP defaults: applied fetch was
          // unavailable, and either the canonical node persisted the
          // external as `draft: null` OR the canonical baseline carries
          // no entry at all (e.g. after a stale-conflict refresh whose
          // GET response did not enumerate externals). In both cases
          // the user has nothing real to validate against, so a
          // metadata-only save must be allowed through. Skip validation
          // **only while the user has not touched this section** — once
          // they start editing the blank defaults the live IP rules
          // fire so a touched-but-invalid section can never round-trip
          // to the wire (`buildDraftSubmission` serialises any touched
          // section). `isExternalSectionTouched` reads the current RHF
          // `dirtyFields` snapshot at parse time, so the schema does
          // not need to be rebuilt per keystroke.
          const seededFromBlankDefaults = !original || original.draft === null;
          if (seededFromBlankDefaults) {
            const touched = isExternalSectionTouched?.(entry.kind) ?? false;
            if (!touched) continue;
          }
        }
        const subValues = (data as Record<string, unknown>)[prefix];
        const result = schema.safeParse(subValues);
        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({
              ...issue,
              path: [prefix, ...issue.path],
            });
          }
        }
      }
    });
}
