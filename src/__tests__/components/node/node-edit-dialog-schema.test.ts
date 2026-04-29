/**
 * Tests for `buildDialogSchema` — the dynamic Zod schema the dialog
 * mounts. The factory closes over `mode`, `node`, and
 * `appliedExternalDrafts` so it can skip per-service IP validation in
 * the one degraded scenario where blocking would break "editing a node
 * preserves server-side unchanged fields": edit mode, an external
 * persisted as `draft: null`, and the applied-config fetch
 * (`getGigantoConfig` / `getTivanConfig`) was unavailable so no seed
 * is threaded in. Without the skip, `dialogSchema.superRefine` blocks
 * even a metadata-only save with blank-IP errors on the external
 * section, even though `buildDraftSubmission` would preserve the
 * original `draft: null` on the wire.
 */
import { describe, expect, it } from "vitest";

import { buildDialogSchema } from "@/components/node/node-edit-dialog-schema";
import type { Node as ManagerNode } from "@/lib/node/types";

function nodeWithDataStoreDraftNull(): ManagerNode {
  return {
    id: "n1",
    name: "alpha",
    nameDraft: null,
    profile: {
      customerId: "c1",
      description: "",
      hostname: "alpha.local",
    },
    profileDraft: null,
    agents: [],
    externalServices: [
      {
        node: 1,
        key: "alpha-data-store",
        kind: "DATA_STORE",
        status: "ENABLED",
        draft: null,
      },
    ],
  } as unknown as ManagerNode;
}

const validMetadata = {
  name: "alpha",
  customerId: "c1",
  description: "",
  hostname: "alpha.local",
};

const blankDataStore = {
  receiveIp: "",
  receivePort: 38370,
  ackTransmission: 1024,
  sendIp: "",
  sendPort: 38371,
  webIp: "",
  webPort: 8442,
  retention: { value: 100, unit: "d" as const },
  maxMbOfLevelBase: 512,
  maxSubcompactions: 2,
  numOfThread: 8,
  maxOpenFiles: 8000,
};

function membershipDataStoreOnly() {
  return {
    sensor: { enabled: false, configMode: "configure-here" as const },
    "data-store": { enabled: true, configMode: "configure-here" as const },
    "ti-container": { enabled: false, configMode: "configure-here" as const },
    "semi-supervised": {
      enabled: false,
      configMode: "configure-here" as const,
    },
    "time-series": { enabled: false, configMode: "configure-here" as const },
    unsupervised: { enabled: false, configMode: "configure-manually" as const },
  };
}

describe("buildDialogSchema — applied-fetch fallback", () => {
  it("skips external IP validation when edit + draft:null + no applied seed", () => {
    // Reviewer Round 4 (#374): when the Settings page swallows
    // `ExternalServiceUnavailableError`, `appliedExternalDrafts` is
    // empty. The dialog falls back to blank-IP defaults, but a
    // metadata-only save must still go through. The schema must let
    // this submit pass so `buildDraftSubmission` can preserve the
    // original `draft: null`.
    const schema = buildDialogSchema({
      mode: "edit",
      node: nodeWithDataStoreDraftNull(),
      appliedExternalDrafts: {},
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(true);
  });

  it("validates external IPs when an applied seed is available", () => {
    // Giganto reachable → we expect the user to see live IP errors as
    // they edit, so the schema must not skip in this branch.
    const schema = buildDialogSchema({
      mode: "edit",
      node: nodeWithDataStoreDraftNull(),
      appliedExternalDrafts: {
        "data-store": "ingest_srv_addr = '1.2.3.4:38370'\n",
      },
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(false);
  });

  it("validates external IPs in create mode regardless of applied seed", () => {
    // Create mode has no preserve-untouched escape hatch — a brand-new
    // external membership must carry valid IPs.
    const schema = buildDialogSchema({
      mode: "create",
      node: null,
      appliedExternalDrafts: {},
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(false);
  });

  it("validates external IPs when the user has touched the section, even with no applied seed", () => {
    // Reviewer Round 5 (#374): the applied-fetch fallback skip must
    // not be unconditional. Once the user starts editing the
    // blank-default fields, `buildDraftSubmission` will serialise the
    // touched section and post whatever is in the form bag, so the
    // per-service IP rules have to fire to prevent invalid drafts
    // from round-tripping to the wire. The dialog supplies an
    // `isExternalSectionTouched` callback that reads RHF's live
    // `dirtyFields` snapshot; we simulate "touched" here by returning
    // true for the kind under test.
    const schema = buildDialogSchema({
      mode: "edit",
      node: nodeWithDataStoreDraftNull(),
      appliedExternalDrafts: {},
      isExternalSectionTouched: (kind) => kind === "data-store",
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(false);
  });

  it("still skips external IPs when the user has not touched the section", () => {
    // Mirror of the previous test with the callback returning false
    // for every kind — pins that the skip path is preserved when the
    // user has not interacted with the blank-default section, so a
    // metadata-only save still goes through with the applied fetch
    // unavailable.
    const schema = buildDialogSchema({
      mode: "edit",
      node: nodeWithDataStoreDraftNull(),
      appliedExternalDrafts: {},
      isExternalSectionTouched: () => false,
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(true);
  });

  it("skips external IP validation when the canonical baseline carries no external entry and user is untouched", () => {
    // Stale-conflict refresh path: after "Keep editing" the dialog
    // swaps `baselineNode` to the freshly-fetched canonical node. If
    // that GET response does not enumerate the external (e.g. a thin
    // node fixture, or a manager projection that omits it), the form
    // still carries blank-IP defaults from the original mount and the
    // user has not touched the section. The schema must let the next
    // metadata-only save through — otherwise the second PATCH never
    // fires and the user is stuck with no way to retry.
    const node = nodeWithDataStoreDraftNull();
    node.externalServices = [];
    const schema = buildDialogSchema({
      mode: "edit",
      node,
      appliedExternalDrafts: {},
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(true);
  });

  it("validates external IPs when the original external had a pending draft", () => {
    // `draft !== null` means the section already carries a baseline
    // (the persisted pending draft). The skip applies only to the
    // "no baseline available anywhere" case, so a stale pending draft
    // must still validate.
    const node = nodeWithDataStoreDraftNull();
    if (node.externalServices[0]) {
      (node.externalServices[0] as { draft: string | null }).draft =
        "ingest_srv_addr = '5.6.7.8:38370'\n";
    }
    const schema = buildDialogSchema({
      mode: "edit",
      node,
      appliedExternalDrafts: {},
    });
    const result = schema.safeParse({
      metadata: validMetadata,
      membership: membershipDataStoreOnly(),
      dataStore: blankDataStore,
    });
    expect(result.success).toBe(false);
  });
});
