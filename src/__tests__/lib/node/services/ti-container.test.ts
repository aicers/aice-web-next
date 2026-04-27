import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultTiContainerValues,
  deserialiseTiContainer,
  serialiseTiContainer,
  tiContainerFormSchema,
} from "@/lib/node/services/ti-container";

const FIXTURE = path.join(
  process.cwd(),
  "src",
  "__tests__",
  "lib",
  "node",
  "fixtures",
  "ti-container.toml",
);

describe("TI Container (Tivan) form", () => {
  it("serialises defaults to the pinned TOML and round-trips back", () => {
    const values = { ...defaultTiContainerValues(), webIp: "10.0.0.1" };
    const toml = serialiseTiContainer(values);
    expect(toml).toBe(readFileSync(FIXTURE, "utf8"));
    expect(deserialiseTiContainer(toml)).toEqual(values);
  });

  it("requires the web IP", () => {
    const issues = tiContainerFormSchema.safeParse(defaultTiContainerValues());
    expect(issues.success).toBe(false);
  });
});
