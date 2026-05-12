/**
 * Drift guard for the inlined constants in `compose.mjs`.
 *
 * `compose.mjs` is plain ESM and cannot import from `tunables.ts` /
 * `categories.ts` because the measurement harness loads it from plain
 * Node and `.ts` files do not resolve there. To keep the production
 * algorithm and the harness in lock-step, the constants are inlined
 * inside `compose.mjs` and this test asserts they still match the
 * canonical TS source. A future tunable change must update both
 * places, and this test will fail loudly until they do.
 */

import { describe, expect, it } from "vitest";
import { FAVORED_BUCKETS } from "@/lib/triage/baseline/categories";
import { _inlinedConstants } from "@/lib/triage/baseline/compose.mjs";
import {
  FINAL_COUNT,
  MAX_TAGS,
  SELECTOR_TAGS,
  SLOT_ALLOCATION,
} from "@/lib/triage/baseline/tunables";

describe("compose.mjs inlined constants — drift guard", () => {
  it("HTTP_THREAT_KIND matches the kind string the SQL row check uses", () => {
    expect(_inlinedConstants.HTTP_THREAT_KIND).toBe("HttpThreat");
  });

  it("UNLABELED_TAG matches SELECTOR_TAGS.UNLABELED_CLUSTER", () => {
    expect(_inlinedConstants.UNLABELED_TAG).toBe(
      SELECTOR_TAGS.UNLABELED_CLUSTER,
    );
  });

  it("MAX_TAGS matches tunables.ts", () => {
    expect(_inlinedConstants.MAX_TAGS).toBe(MAX_TAGS);
  });

  it("SLOT_ALLOCATION matches tunables.ts", () => {
    expect(_inlinedConstants.SLOT_ALLOCATION).toEqual(SLOT_ALLOCATION);
  });

  it("FINAL_COUNT matches tunables.ts", () => {
    expect(_inlinedConstants.FINAL_COUNT).toEqual(FINAL_COUNT);
  });

  it("FAVORED_BUCKETS matches categories.ts", () => {
    expect([..._inlinedConstants.FAVORED_BUCKETS].sort()).toEqual(
      [...FAVORED_BUCKETS].sort(),
    );
  });
});
