import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSchema, GraphQLInterfaceType } from "graphql";
import { describe, expect, it } from "vitest";

import { CURATED_EVENT_TYPENAMES } from "@/lib/detection/types";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/review.graphql");

describe("detection curated Event typenames", () => {
  it("every curated __typename implements the Event interface in the vendored schema", () => {
    // Regression guard: the `Event` discriminated union in
    // `src/lib/detection/types.ts` pins concrete `__typename`
    // literals for the UI to dispatch on. If a schema-pin bump
    // renames or drops one of those types, this test fails so the
    // curated list is corrected in the same PR.
    const sdl = readFileSync(SCHEMA_PATH, "utf8");
    const schema = buildSchema(sdl);
    const eventInterface = schema.getType("Event");
    expect(eventInterface).toBeInstanceOf(GraphQLInterfaceType);
    const implementors = new Set(
      schema
        .getImplementations(eventInterface as GraphQLInterfaceType)
        .objects.map((o) => o.name),
    );
    for (const typename of CURATED_EVENT_TYPENAMES) {
      expect(
        implementors.has(typename),
        `"${typename}" is listed in CURATED_EVENT_TYPENAMES but is not an implementor of the Event interface in schemas/review.graphql`,
      ).toBe(true);
    }
  });
});
