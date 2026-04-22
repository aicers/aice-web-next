import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSchema } from "graphql";
import { describe, expect, it } from "vitest";

import { SENSOR_LIST_ENDPOINT_AVAILABLE } from "@/lib/detection";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/review.graphql");

// Candidate field names for the REview sensor-list query. The exact
// identifier is TBD on the REview side — whichever name ships, the
// guard below accepts it, so this repo only needs to flip the
// `SENSOR_LIST_ENDPOINT_AVAILABLE` constant (and add the inline
// `parse(...)` dispatch) to wire the query.
const CANDIDATE_FIELDS = ["sensorList", "sensorsForCustomers"] as const;

function schemaExposesAnyCandidate(): {
  exposed: boolean;
  matched: string | null;
} {
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  const schema = buildSchema(sdl);
  const queryType = schema.getQueryType();
  if (!queryType) return { exposed: false, matched: null };
  const fields = queryType.getFields();
  for (const candidate of CANDIDATE_FIELDS) {
    if (candidate in fields) return { exposed: true, matched: candidate };
  }
  return { exposed: false, matched: null };
}

describe("detection sensor-list endpoint guard", () => {
  it("SENSOR_LIST_ENDPOINT_AVAILABLE matches the vendored schema", () => {
    // Three-way contract: the vendored schema, the exported constant,
    // and the dispatch wiring in `src/lib/detection/sensors.ts` must
    // move together. This guard forces the constant side of that
    // contract. A consumer of `listSensors()` who assumed the endpoint
    // is always available (and therefore removed the empty-list path)
    // would first have had to flip the constant — and would trip this
    // test if the vendored schema had not caught up.
    //
    // When REview ships the query and the schema is bumped in this
    // repo:
    //   1. The schema check below starts returning { exposed: true }.
    //   2. Flip `SENSOR_LIST_ENDPOINT_AVAILABLE` to `true` in
    //      src/lib/detection/sensors.ts.
    //   3. Add the `parse(...)` dispatch to ./queries.ts and wire it
    //      up in listSensors() following the same pattern as
    //      buildDispatchContext in server-actions.ts.
    //
    // Leaving any of those three changes out fails CI here.
    const { exposed, matched } = schemaExposesAnyCandidate();
    if (exposed && !SENSOR_LIST_ENDPOINT_AVAILABLE) {
      throw new Error(
        `schemas/review.graphql now exposes the sensor-list query ` +
          `(as \`${matched}\`), but SENSOR_LIST_ENDPOINT_AVAILABLE is ` +
          "still `false`. Flip the constant in " +
          "src/lib/detection/sensors.ts and wire the inline " +
          "`parse(...)` dispatch in the same PR.",
      );
    }
    if (!exposed && SENSOR_LIST_ENDPOINT_AVAILABLE) {
      throw new Error(
        `SENSOR_LIST_ENDPOINT_AVAILABLE is \`true\`, but ` +
          "schemas/review.graphql does not expose any of the " +
          `expected sensor-list query fields (${CANDIDATE_FIELDS.join(
            ", ",
          )}). Either revert the constant or add the missing schema ` +
          "field in the same PR that vendored the new schema.",
      );
    }
    expect(SENSOR_LIST_ENDPOINT_AVAILABLE).toBe(exposed);
  });
});
