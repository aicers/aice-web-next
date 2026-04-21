import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GENERATED_PATH = path.join(
  REPO_ROOT,
  "src/lib/detection/types.generated.ts",
);

describe("detection types codegen", () => {
  it("checked-in types.generated.ts matches the generator output", async () => {
    // Regression guard: if `schemas/review.graphql` changes in a way
    // that affects any of the Detection-facing types (inputs, enums,
    // pagination, counters, the Event interface) the generator's
    // output will drift from the committed file and this test fails.
    //
    // Regenerate with `pnpm codegen:detection` in the same PR that
    // bumps `schemas/review.graphql` and `schemas/review.version`.
    const script = await import(
      /* @vite-ignore */ path.join(
        REPO_ROOT,
        "scripts/codegen-detection-types.mjs",
      )
    );
    const fresh = script.generate();
    const onDisk = readFileSync(GENERATED_PATH, "utf8");
    expect(fresh).toBe(onDisk);
  });
});
