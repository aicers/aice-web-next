"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FieldValues,
  FormProvider,
  type UseFormReturn,
  useForm,
  useFormContext,
} from "react-hook-form";
import { SemiSupervisedForm } from "@/components/node/forms/semi-supervised-form";
import { buildDialogSchema } from "@/components/node/node-edit-dialog-schema";
import {
  buildDraftSubmission,
  type ConfigMode,
  type DirtyMap,
  PREFIX_BY_REGISTRY_KIND,
  pruneSensorsAgainstPool,
  registryKindForExternalKind,
  type ServiceMembershipState,
  seedMembershipFromNode,
  serviceTouchedByUser,
} from "@/components/node/node-edit-dialog-state";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { NodeMetadataValues } from "@/lib/node/node-metadata-schema";
import type { SensorNodeOption } from "@/lib/node/sensor-list";
import {
  getService,
  listServices,
  type ServiceMode,
} from "@/lib/node/service-registry";
import type {
  AgentInput,
  ExternalServiceInput,
  Node as ManagerNode,
  NodeDraftInput,
  NodeInput,
} from "@/lib/node/types";

import { FieldError } from "./forms/shared/field-error";

interface CustomerOption {
  id: string;
  name: string;
}

export type NodeEditDialogMode = "create" | "edit";

export interface NodeEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: NodeEditDialogMode;
  customers: readonly CustomerOption[];
  /** Names already in use; used for the client-side uniqueness pre-check. */
  existingNames: readonly string[];
  existingHostnames: readonly string[];
  /** Sensor options for the Semi-supervised Engine form. */
  sensorOptions?: readonly SensorNodeOption[];
  /** When `mode === "edit"`, the canonical node payload. */
  node?: ManagerNode | null;
  /**
   * Applied external-service config projected to the TOML wire format
   * the per-service `deserialise` consumes, keyed by registry kind
   * (`data-store`, `ti-container`). The Settings page fetches these
   * via `getGigantoConfig` / `getTivanConfig` for any external the
   * node hosts with `draft: null`, so the Edit dialog opens with the
   * actual applied baseline rather than blank-IP defaults — without
   * this seed, `dialogSchema.superRefine`'s IP validation would block
   * even a metadata-only edit on a node that has applied externals.
   */
  appliedExternalDrafts?: Readonly<Record<string, string>>;
  onSuccess: () => void;
}

interface DialogFormShape extends FieldValues {
  metadata: NodeMetadataValues;
  membership: Record<string, ServiceMembershipState>;
  // Per-service form values live alongside `metadata` and `membership`
  // under their canonical camelCase prefixes. They are typed loose here
  // because each per-service form module owns its own value shape.
  [serviceKey: string]: unknown;
}

const EMPTY_SENSOR_OPTIONS: readonly SensorNodeOption[] = Object.freeze([]);
const EMPTY_APPLIED_EXTERNAL_DRAFTS: Readonly<Record<string, string>> =
  Object.freeze({});

function buildDefaultValues(
  node: ManagerNode | null | undefined,
  customers: readonly CustomerOption[],
  sensorOptions: readonly SensorNodeOption[],
  appliedExternalDrafts: Readonly<Record<string, string>>,
): { values: DialogFormShape } {
  const profile = node?.profileDraft ?? node?.profile ?? null;
  const metadata: NodeMetadataValues = {
    name: node?.nameDraft ?? node?.name ?? "",
    customerId:
      profile?.customerId ??
      (customers.length === 1 ? (customers[0]?.id ?? "") : ""),
    description: profile?.description ?? "",
    hostname: profile?.hostname ?? "",
  };
  const { membership, draftByKind } = seedMembershipFromNode(
    node,
    appliedExternalDrafts,
  );
  const values: DialogFormShape = { metadata, membership };
  for (const entry of listServices()) {
    const prefix = PREFIX_BY_REGISTRY_KIND[entry.kind];
    if (!prefix) continue;
    const ctx = {
      sensorPool: sensorOptions.map((s) => s.id),
    };
    const draft = draftByKind[entry.kind];
    if (draft) {
      try {
        values[prefix] = entry.module.deserialise(draft, ctx);
      } catch {
        values[prefix] = entry.module.defaults(null, ctx);
      }
    } else {
      values[prefix] = entry.module.defaults(null, ctx);
    }
  }
  return { values };
}

export function NodeEditDialog({
  open,
  onOpenChange,
  mode,
  customers,
  existingNames,
  existingHostnames,
  sensorOptions = EMPTY_SENSOR_OPTIONS,
  node,
  appliedExternalDrafts = EMPTY_APPLIED_EXTERNAL_DRAFTS,
  onSuccess,
}: NodeEditDialogProps) {
  const t = useTranslations("nodes.dialog");
  const tServiceLabels = useTranslations("nodes.serviceLabels");
  const tValidation = useTranslations("nodes.dialog.validation");

  // Snapshot the validation message strings up front so the schema
  // factory closes over stable references — `useTranslations` is keyed
  // by the active locale, so the memo only invalidates when the locale
  // actually changes (not on every render).
  const metadataMessages = useMemo(
    () => ({
      required: tValidation("required"),
      tooLong: (max: number) => tValidation("tooLong", { max }),
      disallowedChar: tValidation("disallowedChar"),
      noWhitespace: tValidation("noWhitespace"),
      invalidHostname: tValidation("invalidHostname"),
    }),
    [tValidation],
  );

  // The dialog tracks its own canonical-node baseline so the
  // stale-conflict reconciliation prompt can refresh it without
  // bouncing the dialog back through the parent. `node` (the prop)
  // remains the *initial* baseline for first mount; after a Keep
  // editing or Discard refresh, `baselineNode` carries the freshly
  // re-fetched payload, which is what `buildOldNodeInput` and the
  // submission helpers must consume — otherwise the next PATCH would
  // re-send the original (stale) `old` and trip the CAS check again.
  const [baselineNode, setBaselineNode] = useState<ManagerNode | null>(
    node ?? null,
  );
  // Externals (Data Store / TI Container) carry only `draft` on the
  // node payload; their applied baseline lives on Giganto / Tivan and
  // is fetched server-side. The prop carries the snapshot the SSR
  // page captured when the dialog first opened; on a stale-conflict
  // refresh the BFF GET re-projects the *current* applied baseline
  // and the dialog must re-seed external sections from that fresh
  // map. Without this, `Discard my edits and reload` still shows
  // pre-conflict applied values for externals, and `Keep editing`
  // lets a single touched external field re-serialise the whole
  // section with stale untouched subfields.
  const [liveAppliedExternalDrafts, setLiveAppliedExternalDrafts] = useState<
    Readonly<Record<string, string>>
  >(appliedExternalDrafts);
  // Hog's `active_sensors` checklist renders against a pool collected
  // from every node hosting a SENSOR agent. The prop carries the SSR
  // snapshot; on a stale-conflict refresh the BFF returns the current
  // pool alongside the refreshed node so we can rebuild defaults and
  // re-serialise Hog against fresh ids. Without this, the dialog
  // would still serialise against the original pool and
  // `serialiseSemiSupervised`'s set-equality "all checked → None"
  // rule could collapse the user's selection to `None`, which the
  // manager reads as the *current* (drifted) pool — silently selecting
  // sensors the user never saw. The pool is keyed by node id, so
  // membership in `liveSensorOptions` is what gates that asymmetric
  // omission.
  const [liveSensorOptions, setLiveSensorOptions] =
    useState<readonly SensorNodeOption[]>(sensorOptions);

  // Whenever the parent swaps to a new edit target the node id
  // changes; reset our internal baseline so the form rebuilds against
  // the fresh canonical payload rather than the previous target's.
  useEffect(() => {
    setBaselineNode(node ?? null);
  }, [node]);
  useEffect(() => {
    setLiveAppliedExternalDrafts(appliedExternalDrafts);
  }, [appliedExternalDrafts]);
  useEffect(() => {
    setLiveSensorOptions(sensorOptions);
  }, [sensorOptions]);

  const initial = useMemo(
    () =>
      buildDefaultValues(
        baselineNode,
        customers,
        liveSensorOptions,
        liveAppliedExternalDrafts,
      ).values,
    [baselineNode, customers, liveSensorOptions, liveAppliedExternalDrafts],
  );

  // The schema's applied-fetch fallback skip is gated on the user not
  // having touched the external section. We don't want the schema to
  // rebuild on every keystroke (rebuilding swaps the resolver and can
  // reset dirty tracking), so the dirty check goes through a ref to
  // the form instance — `formRef.current.formState.dirtyFields` reads
  // RHF's live snapshot at parse time. RHF updates `dirtyFields`
  // synchronously before invoking the resolver, so the closure
  // observes the in-flight edit.
  const formRef = useRef<UseFormReturn<DialogFormShape> | null>(null);
  const isExternalSectionTouched = useCallback((kind: string) => {
    const f = formRef.current;
    if (!f) return false;
    return serviceTouchedByUser(kind, f.formState.dirtyFields as DirtyMap);
  }, []);

  const dialogSchema = useMemo(
    () =>
      buildDialogSchema({
        mode,
        node: baselineNode,
        appliedExternalDrafts: liveAppliedExternalDrafts,
        isExternalSectionTouched,
        metadataMessages,
      }),
    [
      mode,
      baselineNode,
      liveAppliedExternalDrafts,
      isExternalSectionTouched,
      metadataMessages,
    ],
  );

  const form = useForm<DialogFormShape>({
    resolver: zodResolver(dialogSchema as never) as never,
    mode: "onChange",
    defaultValues: initial as never,
  });
  formRef.current = form;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Per-service inline error placement for `field === "service"`
  // conflicts — the BFF returns the registry kind via `serviceKind`
  // when it can identify the affected accordion section. Cleared at
  // the start of every Save attempt.
  const [serviceError, setServiceError] = useState<{
    kind: string;
    message: string;
  } | null>(null);
  // Distinct stale-conflict reconciliation prompt UI for `field === null`
  // — separate state from the generic footer banner so the prompt can
  // offer Discard / Keep-editing buttons rather than a flat error
  // message. Driven only by the BFF's documented `field: null` shape
  // (double-stale on PATCH, or any unmatched conflict propagated as
  // generic 5xx).
  const [staleConflict, setStaleConflict] = useState<string | null>(null);
  // The reconciliation prompt fires a GET to refresh the canonical
  // baseline before the user continues. Track that fetch so the
  // buttons can show a busy state and the dialog cannot dispatch a
  // new save while a refresh is in flight (which would race the
  // baseline swap).
  const [reconciling, setReconciling] = useState(false);
  // Surface a compact error when the refresh itself fails (e.g. the
  // node was deleted between the conflict and the retry, or the
  // manager is down) so the user is not silently stuck on a stale
  // baseline. The prompt stays open with the new error inline so
  // they can try again.
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  // Reset only on the closed→open transition. Re-running on every
  // `initial` reference change would loop: form.reset triggers a
  // re-render, the parent may pass a fresh `customers` / `node` ref,
  // useMemo rebuilds `initial`, and we'd reset again.
  //
  // Local error state lives outside RHF (`submitError`,
  // `serviceError`, `staleConflict`, `reconcileError`), so a
  // create-mode dialog kept mounted by the list page would still show
  // a previous attempt's banner / inline error / reconciliation prompt
  // after Cancel → reopen. Clear them here so the reopened dialog
  // starts clean.
  //
  // `service.set_mode` audit emission is owned server-side now: the
  // BFF derives mode changes from the persisted before/after agent
  // draft strings, so the dialog no longer needs to snapshot and diff
  // membership state across the open/save lifecycle.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      form.reset(initial as never);
      setSubmitError(null);
      setServiceError(null);
      setStaleConflict(null);
      setReconcileError(null);
    }
    wasOpen.current = open;
  }, [open, initial, form]);

  const refreshBaseline = useCallback(async (): Promise<{
    node: ManagerNode;
    appliedExternalDrafts: Readonly<Record<string, string>>;
    sensorOptions: readonly SensorNodeOption[];
  } | null> => {
    if (!baselineNode) return null;
    const res = await fetch(
      `/api/nodes/${encodeURIComponent(baselineNode.id)}`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      node: ManagerNode;
      appliedExternalDrafts?: Record<string, string>;
      sensorOptions?: SensorNodeOption[];
    };
    // Merge per-kind. The BFF fetches Giganto and Tivan independently
    // and swallows `ExternalServiceUnavailableError` per service, so a
    // node hosting both can legitimately come back with one kind
    // populated and the other omitted (e.g. only Giganto succeeded).
    // Replacing wholesale would drop the previous seed for the
    // missing kind and force `dialogSchema.superRefine` to validate
    // the section's form bag against the blank registry defaults — a
    // touched section would then re-serialize stale untouched
    // subfields back over a concurrent writer's change, the very
    // class of bug the Round 12 baseline-refresh fix closed for the
    // both-kinds-present path.
    //
    // Resolution rule: walk the *refreshed* node's external services,
    // and for each kind hosted with `draft: null` prefer the response
    // value, falling back to the previous seed only when the response
    // omits that kind (transient fetch failure). Kinds the refreshed
    // node no longer hosts with `draft: null` are dropped — the seed
    // is no longer load-bearing for them. When `appliedExternalDrafts`
    // is undefined entirely (older response shape), the prior seed is
    // preserved for every still-hosted kind via the same fallback.
    const responseDrafts = body.appliedExternalDrafts;
    const merged: Record<string, string> = {};
    for (const ext of body.node.externalServices) {
      if (ext.draft !== null) continue;
      const regKind = registryKindForExternalKind(ext.kind);
      if (!regKind) continue;
      const fromResponse = responseDrafts?.[regKind];
      if (fromResponse !== undefined) {
        merged[regKind] = fromResponse;
      } else if (liveAppliedExternalDrafts[regKind] !== undefined) {
        merged[regKind] = liveAppliedExternalDrafts[regKind];
      }
    }
    // The sensor pool is the second moving target across a refresh:
    // a concurrent writer can add/remove a SENSOR agent on another
    // node between dialog open and the retry, drifting the pool that
    // `serialiseSemiSupervised`'s "all checked → None" rule compares
    // against. The BFF returns the current pool alongside the node;
    // older response shapes (or a transient pool fetch failure) fall
    // back to the previous live pool so a missing field never blanks
    // an otherwise-populated section.
    const refreshedSensorOptions = body.sensorOptions ?? liveSensorOptions;
    return {
      node: body.node,
      appliedExternalDrafts: merged,
      sensorOptions: refreshedSensorOptions,
    };
  }, [baselineNode, liveAppliedExternalDrafts, liveSensorOptions]);

  const focusField = useCallback((field: string) => {
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-node-dialog-field="${field}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus();
    });
  }, []);

  const clientPrecheckUniqueness = useCallback(
    (values: NodeMetadataValues): "name" | "hostname" | null => {
      // Both the applied name AND the pending draft name belong to
      // "this" node — typing either should never collide with itself.
      // Only excluding `nameDraft ?? name` would falsely reject a user
      // reverting `name=alpha`/`nameDraft=beta` back to `alpha`, since
      // `existingNames` carries both per-row entries from the list.
      //
      // We exclude entries from BOTH `node` (the prop snapshot used to
      // build the list-derived `existingNames` / `existingHostnames`)
      // AND `baselineNode` (which can diverge from `node` after a
      // stale-conflict reconciliation refresh). The list itself is
      // not refetched on refresh, so without the prop snapshot the
      // refreshed baseline would falsely flag the original (still
      // listed) hostname as taken by another node.
      const ownNames = new Set<string>();
      const addName = (s: string | null | undefined) => {
        if (s) ownNames.add(s.toLowerCase());
      };
      addName(baselineNode?.name);
      addName(baselineNode?.nameDraft);
      addName(node?.name);
      addName(node?.nameDraft);
      const ownHosts = new Set<string>();
      const addHost = (s: string | null | undefined) => {
        if (s) ownHosts.add(s.toLowerCase());
      };
      addHost(baselineNode?.profile?.hostname);
      addHost(baselineNode?.profileDraft?.hostname);
      addHost(node?.profile?.hostname);
      addHost(node?.profileDraft?.hostname);
      const candidateName = values.name.toLowerCase();
      if (
        existingNames.some(
          (n) =>
            n.toLowerCase() === candidateName && !ownNames.has(n.toLowerCase()),
        )
      ) {
        form.setError("metadata.name", {
          type: "manual",
          message: t("errors.nameTaken"),
        });
        return "name";
      }
      const candidateHost = values.hostname.toLowerCase();
      if (
        existingHostnames.some(
          (h) =>
            h.toLowerCase() === candidateHost && !ownHosts.has(h.toLowerCase()),
        )
      ) {
        form.setError("metadata.hostname", {
          type: "manual",
          message: t("errors.hostnameTaken"),
        });
        return "hostname";
      }
      return null;
    },
    [existingNames, existingHostnames, baselineNode, node, form, t],
  );

  const sensorPool = useMemo(
    () => liveSensorOptions.map((s) => s.id),
    [liveSensorOptions],
  );

  const buildAgentsAndExternals = useCallback(
    (
      values: DialogFormShape,
      dirtyFields: DirtyMap,
    ): {
      agents: ReturnType<typeof buildDraftSubmission>["agents"];
      externalServices: ReturnType<
        typeof buildDraftSubmission
      >["externalServices"];
    } => {
      // Per-service serialise indirection: Configure-Here forms are
      // validated up-front by `dialogSchema`'s `superRefine`, so reaching
      // this point means `serialise` will succeed. Letting an exception
      // propagate is the right behaviour — silently substituting
      // `draft = ""` would post a wire-encoded Manually mode for a
      // Configure-Here service.
      return buildDraftSubmission({
        values,
        dirtyFields,
        mode,
        node: baselineNode,
        sensorPool,
        appliedExternalDrafts: liveAppliedExternalDrafts,
        serialise: (registryKind, vals) =>
          getService(registryKind).module.serialise(vals as never, {
            activeSensorsPool: sensorPool,
          }),
      });
    },
    [mode, baselineNode, sensorPool, liveAppliedExternalDrafts],
  );

  const buildOldNodeInput = useCallback(
    (n: ManagerNode): NodeInput => ({
      name: n.name,
      nameDraft: n.nameDraft,
      profile: n.profile
        ? {
            customerId: n.profile.customerId,
            description: n.profile.description,
            hostname: n.profile.hostname,
          }
        : null,
      profileDraft: n.profileDraft
        ? {
            customerId: n.profileDraft.customerId,
            description: n.profileDraft.description,
            hostname: n.profileDraft.hostname,
          }
        : null,
      agents: n.agents.map<AgentInput>((a) => ({
        kind: a.kind,
        key: a.key,
        status: a.status,
        config: a.config,
        draft: a.draft,
      })),
      externalServices: n.externalServices.map<ExternalServiceInput>((e) => ({
        kind: e.kind,
        key: e.key,
        status: e.status,
        draft: e.draft,
      })),
    }),
    [],
  );

  const onValid = form.handleSubmit(async (values) => {
    setSubmitError(null);
    setServiceError(null);
    setStaleConflict(null);
    const conflict = clientPrecheckUniqueness(values.metadata);
    if (conflict) {
      focusField(`metadata.${conflict}`);
      return;
    }

    setSubmitting(true);
    try {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      const { agents, externalServices } = buildAgentsAndExternals(
        values,
        form.formState.dirtyFields as DirtyMap,
      );

      let res: Response;
      if (mode === "create") {
        res = await fetch("/api/nodes", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: values.metadata.name,
            customerId: values.metadata.customerId,
            description: values.metadata.description,
            hostname: values.metadata.hostname,
            agents,
            externalServices,
          }),
        });
      } else {
        if (!baselineNode) throw new Error("Edit mode without a node payload");
        const newDraft: NodeDraftInput = {
          nameDraft: values.metadata.name,
          profileDraft: {
            customerId: values.metadata.customerId,
            description: values.metadata.description,
            hostname: values.metadata.hostname,
          },
          agents,
          externalServices,
        };
        res = await fetch(`/api/nodes/${encodeURIComponent(baselineNode.id)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            old: buildOldNodeInput(baselineNode),
            new: newDraft,
          }),
        });
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          field?: string | null;
          serviceKind?: string;
        } | null;
        const message = body?.error ?? t("errors.generic");
        if (body?.field === "name") {
          form.setError("metadata.name", { type: "server", message });
          focusField("metadata.name");
        } else if (body?.field === "hostname") {
          form.setError("metadata.hostname", { type: "server", message });
          focusField("metadata.hostname");
        } else if (body?.field === "customerId") {
          form.setError("metadata.customerId", { type: "server", message });
          focusField("metadata.customerId");
        } else if (body?.field === "service") {
          // Pin the inline error to the affected accordion when the
          // BFF identified the service kind from the upstream
          // "agent <key> not found" message; otherwise fall back to a
          // contextualised footer banner that names the service so the
          // user is not left guessing.
          if (body.serviceKind) {
            setServiceError({ kind: body.serviceKind, message });
            focusField(`service.${body.serviceKind}`);
          } else {
            setSubmitError(message);
          }
        } else if (body?.field === null || body?.field === undefined) {
          // The BFF returns `field: null` when the conflict has no
          // single field surface — most importantly the double-stale
          // case from PATCH. Render the reconciliation prompt so the
          // user can choose to discard or keep editing instead of a
          // flat banner that conflates this with generic errors.
          if (res.status === 409) {
            setStaleConflict(message);
          } else {
            setSubmitError(message);
          }
        } else {
          setSubmitError(message);
        }
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[min(92vw,42rem)] max-w-none overflow-y-auto sm:max-w-2xl"
        data-testid="node-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? t("titleCreate") : t("titleEdit")}
          </DialogTitle>
        </DialogHeader>

        <FormProvider {...form}>
          <form onSubmit={onValid} className="space-y-6">
            <MetadataFields customers={customers} />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">{t("servicesHeading")}</h3>
              <div className="space-y-2">
                {listServices().map((entry) => (
                  <ServiceAccordion
                    key={entry.kind}
                    kind={entry.kind}
                    label={tServiceLabels(entry.labelKey)}
                    mode={entry.mode}
                    sensorOptions={liveSensorOptions}
                    serviceError={
                      serviceError?.kind === entry.kind
                        ? serviceError.message
                        : null
                    }
                  />
                ))}
              </div>
            </section>

            {staleConflict && (
              <section
                role="alert"
                className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3 text-sm"
                data-testid="node-dialog-stale-conflict"
              >
                <p className="text-destructive font-medium">
                  {t("stale.title")}
                </p>
                <p className="text-muted-foreground">{staleConflict}</p>
                {reconcileError && (
                  <p
                    className="text-destructive text-xs"
                    data-testid="node-dialog-stale-error"
                  >
                    {reconcileError}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={reconciling}
                    data-testid="node-dialog-stale-discard"
                    onClick={async () => {
                      // Discard local edits and reload: refetch the
                      // canonical node, replace the baseline AND
                      // reset the form to the freshly-derived
                      // defaults. The dialog stays open so the user
                      // can keep editing on top of the refreshed
                      // state — the manual text describes this as
                      // "discard the local edits and reload".
                      setReconciling(true);
                      setReconcileError(null);
                      try {
                        const fresh = await refreshBaseline();
                        if (!fresh) {
                          // Should not happen — `Discard` only
                          // surfaces in edit mode where the baseline
                          // is non-null.
                          throw new Error(t("errors.generic"));
                        }
                        setBaselineNode(fresh.node);
                        setLiveAppliedExternalDrafts(
                          fresh.appliedExternalDrafts,
                        );
                        setLiveSensorOptions(fresh.sensorOptions);
                        const next = buildDefaultValues(
                          fresh.node,
                          customers,
                          fresh.sensorOptions,
                          fresh.appliedExternalDrafts,
                        ).values;
                        form.reset(next as never);
                        setStaleConflict(null);
                        setSubmitError(null);
                        setServiceError(null);
                      } catch (err) {
                        setReconcileError(
                          err instanceof Error
                            ? err.message
                            : t("errors.generic"),
                        );
                      } finally {
                        setReconciling(false);
                      }
                    }}
                  >
                    {reconciling ? t("stale.refreshing") : t("stale.discard")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={reconciling}
                    data-testid="node-dialog-stale-keep"
                    onClick={async () => {
                      // Keep editing and refresh the baseline: the
                      // user's form state stays as-is for fields they
                      // touched, but every untouched field — both
                      // node-metadata and the per-service form bags
                      // — is rebased onto the refreshed baseline so
                      // the next PATCH does not write a stale value
                      // back as if the user had asked for it. Without
                      // the rebase, a flow like "user edits
                      // dataStore.receiveIp, concurrent writer
                      // changes dataStore.webIp, save hits the
                      // double-stale prompt, user chooses Keep
                      // editing" would retry with the pre-refresh
                      // webIp and silently overwrite the concurrent
                      // change. `buildDraftSubmission`'s
                      // section-level preservation only protects
                      // sections the user did not touch at all; once
                      // any field inside a section is dirty it
                      // re-serializes the entire section from the
                      // form values, so per-field rebase across each
                      // service form bag is required to avoid
                      // round-tripping stale untouched-subfield
                      // values.
                      //
                      // We use `form.reset(fresh, { keepDirtyValues:
                      // true })` for the rebase: RHF resets every
                      // field to the new defaults, but for fields
                      // already in `dirtyFields` it keeps the user's
                      // current value. The critical side effect is
                      // that `_defaultValues` is replaced wholesale
                      // — including the membership tree, which is
                      // tracked via `setValue` + `watch` in
                      // `ServiceAccordion` rather than `register`.
                      // The earlier per-leaf approach used `setValue`
                      // for membership (because `resetField` no-ops
                      // on unregistered paths), but `setValue` does
                      // not refresh defaults, so a post-Keep-editing
                      // toggle that landed back on the *pre-refresh*
                      // default would clear `dirtyFields.membership`
                      // and `serviceTouchedByUser` would treat the
                      // service as untouched on Save — silently
                      // dropping the user's mode/enabled change in
                      // favour of the refreshed canonical draft. A
                      // single `form.reset` updates defaults and
                      // values uniformly across registered and
                      // unregistered paths, so dirty tracking lines
                      // up with the refreshed baseline. The
                      // canonical-node baseline is also refreshed so
                      // the next PATCH's `old` reflects the current
                      // server state instead of the original (now
                      // stale) snapshot — without this, every retry
                      // would re-trip the CAS check on the same
                      // stale `old`.
                      setReconciling(true);
                      setReconcileError(null);
                      try {
                        const fresh = await refreshBaseline();
                        if (!fresh) throw new Error(t("errors.generic"));
                        const freshDefaults = buildDefaultValues(
                          fresh.node,
                          customers,
                          fresh.sensorOptions,
                          fresh.appliedExternalDrafts,
                        ).values;
                        form.reset(freshDefaults as never, {
                          keepDirtyValues: true,
                        });
                        // Prune Hog `active_sensors` against the
                        // refreshed pool. `keepDirtyValues: true`
                        // preserves the user's selection array verbatim,
                        // so a sensor that disappeared from the pool
                        // between dialog open and the retry stays in
                        // form state but vanishes from the rendered
                        // checklist (`SemiSupervisedForm` only renders
                        // the refreshed `sensorOptions`). Without this
                        // prune, `serialiseSemiSupervised` would re-emit
                        // the stale id in the explicit `Some([...])`
                        // case and the PATCH body would carry an
                        // `active_sensors` list the user can no longer
                        // see — silently selecting a sensor against the
                        // user's intent. The prune intersects the kept
                        // selection with the refreshed pool ids; if
                        // anything was dropped we replace the array via
                        // `setValue` so the wire payload matches the UI
                        // the user is looking at.
                        const sensorsPath = "semiSupervised.sensors";
                        const kept = form.getValues(sensorsPath as never) as
                          | unknown
                          | undefined;
                        const pruned = pruneSensorsAgainstPool(
                          kept as readonly unknown[] | null | undefined,
                          fresh.sensorOptions.map((s) => s.id),
                        );
                        if (pruned !== null) {
                          form.setValue(sensorsPath as never, pruned as never, {
                            shouldDirty: true,
                            shouldValidate: false,
                          });
                        }
                        setBaselineNode(fresh.node);
                        setLiveAppliedExternalDrafts(
                          fresh.appliedExternalDrafts,
                        );
                        setLiveSensorOptions(fresh.sensorOptions);
                        setStaleConflict(null);
                      } catch (err) {
                        setReconcileError(
                          err instanceof Error
                            ? err.message
                            : t("errors.generic"),
                        );
                      } finally {
                        setReconciling(false);
                      }
                    }}
                  >
                    {reconciling ? t("stale.refreshing") : t("stale.keep")}
                  </Button>
                </div>
              </section>
            )}

            {submitError && (
              <p
                role="alert"
                className="text-destructive text-sm"
                data-testid="node-dialog-form-error"
              >
                {submitError}
              </p>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  data-testid="node-dialog-cancel"
                >
                  {t("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={submitting || reconciling}
                data-testid="node-dialog-save"
              >
                {submitting ? t("saving") : t("save")}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

function MetadataFields({
  customers,
}: {
  customers: readonly CustomerOption[];
}) {
  const t = useTranslations("nodes.dialog");
  const {
    register,
    formState: { errors },
    setValue,
    watch,
  } = useFormContext<DialogFormShape>();
  const customerValue = watch("metadata.customerId") as string | undefined;

  const metaErrors = (errors.metadata ?? {}) as Record<
    string,
    { message?: string } | undefined
  >;

  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <Label htmlFor="node-dialog-name">{t("fields.name")}</Label>
        <Input
          id="node-dialog-name"
          data-node-dialog-field="metadata.name"
          {...register("metadata.name")}
        />
        <FieldError message={metaErrors.name?.message} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="node-dialog-customer">{t("fields.customer")}</Label>
        <Select
          value={customerValue ?? ""}
          onValueChange={(v) =>
            // `shouldDirty: true` is required because the stale-conflict
            // Keep-editing rebase calls
            // `form.reset(freshDefaults, { keepDirtyValues: true })`,
            // which only preserves fields RHF has marked dirty. Without
            // it, a user-changed customer is treated as untouched and
            // overwritten by the refreshed canonical baseline on Keep
            // editing — silently dropping the user's selection.
            setValue("metadata.customerId", v, {
              shouldValidate: true,
              shouldDirty: true,
            })
          }
        >
          <SelectTrigger
            id="node-dialog-customer"
            data-node-dialog-field="metadata.customerId"
            aria-label={t("fields.customer")}
          >
            <SelectValue placeholder={t("fields.customerPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {customers.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={metaErrors.customerId?.message} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="node-dialog-description">
          {t("fields.description")}
        </Label>
        <Input
          id="node-dialog-description"
          data-node-dialog-field="metadata.description"
          {...register("metadata.description")}
        />
        <FieldError message={metaErrors.description?.message} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="node-dialog-hostname">{t("fields.hostname")}</Label>
        <Input
          id="node-dialog-hostname"
          data-node-dialog-field="metadata.hostname"
          {...register("metadata.hostname")}
        />
        <FieldError message={metaErrors.hostname?.message} />
      </div>
    </section>
  );
}

interface ServiceAccordionProps {
  kind: string;
  label: string;
  mode: ServiceMode;
  sensorOptions: readonly SensorNodeOption[];
  /**
   * Inline error pinned to this accordion section by a server-side
   * conflict whose `field === "service"` matched this kind. `null`
   * when no service-level error targets this section.
   */
  serviceError?: string | null;
}

function ServiceAccordion({
  kind,
  label,
  mode,
  sensorOptions,
  serviceError,
}: ServiceAccordionProps) {
  const t = useTranslations("nodes.dialog");
  const { setValue, watch } = useFormContext<DialogFormShape>();
  const enabled =
    (watch(`membership.${kind}.enabled`) as boolean | undefined) ?? false;
  const configMode =
    (watch(`membership.${kind}.configMode`) as ConfigMode | undefined) ??
    (mode === "configure-manually" ? "configure-manually" : "configure-here");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (enabled) setExpanded(true);
  }, [enabled]);

  // Auto-expand when a server-side service-level error targets this
  // section so the inline message is visible without an extra click.
  useEffect(() => {
    if (serviceError) setExpanded(true);
  }, [serviceError]);

  const showConfigSwitch = mode === "both";
  const isManualMode =
    mode === "configure-manually" || configMode === "configure-manually";

  return (
    <div
      data-testid={`node-dialog-service-${kind}`}
      data-service-kind={kind}
      data-service-enabled={enabled ? "true" : "false"}
      data-node-dialog-field={`service.${kind}`}
      tabIndex={-1}
      className="rounded-md border"
    >
      <header className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          aria-label={expanded ? t("collapse") : t("expand")}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <Checkbox
          id={`node-dialog-${kind}-enabled`}
          checked={enabled}
          onCheckedChange={(v) =>
            setValue(`membership.${kind}.enabled`, v === true, {
              shouldDirty: true,
            })
          }
          data-testid={`node-dialog-${kind}-enable`}
        />
        <Label
          htmlFor={`node-dialog-${kind}-enabled`}
          className="cursor-pointer font-medium"
        >
          {label}
        </Label>
        {showConfigSwitch && enabled && (
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span
              className={
                configMode === "configure-here"
                  ? "font-medium"
                  : "text-muted-foreground"
              }
            >
              {t("modes.here")}
            </span>
            <Switch
              checked={configMode === "configure-manually"}
              onCheckedChange={(v) =>
                setValue(
                  `membership.${kind}.configMode`,
                  v ? "configure-manually" : "configure-here",
                  { shouldDirty: true },
                )
              }
              aria-label={t("modes.toggle")}
              data-testid={`node-dialog-${kind}-mode`}
            />
            <span
              className={
                configMode === "configure-manually"
                  ? "font-medium"
                  : "text-muted-foreground"
              }
            >
              {t("modes.manually")}
            </span>
          </div>
        )}
      </header>
      {expanded && enabled && (
        <div className="space-y-2 border-t px-4 py-3">
          {serviceError && (
            <p
              role="alert"
              className="text-destructive text-sm"
              data-testid={`node-dialog-${kind}-error`}
            >
              {serviceError}
            </p>
          )}
          {isManualMode ? (
            <ManualModeCard />
          ) : (
            <ConfigureHereBody kind={kind} sensorOptions={sensorOptions} />
          )}
        </div>
      )}
    </div>
  );
}

function ManualModeCard() {
  const t = useTranslations("nodes.dialog");
  return (
    <p
      className="text-muted-foreground bg-muted/40 rounded-md border p-3 text-sm"
      data-testid="node-dialog-manual-card"
    >
      {t("manualCard")}
    </p>
  );
}

function ConfigureHereBody({
  kind,
  sensorOptions,
}: {
  kind: string;
  sensorOptions: readonly SensorNodeOption[];
}) {
  const entry = getService(kind);
  const Form = entry.formComponent;
  if (!Form) return null;
  // Hog needs the dynamic sensor pool; other forms only take the base
  // `disabled` prop. The cast keeps the dialog generic over the typed
  // prop map without having to enumerate each kind.
  if (kind === "semi-supervised") {
    return <SemiSupervisedForm sensorOptions={sensorOptions} />;
  }
  return <Form />;
}
