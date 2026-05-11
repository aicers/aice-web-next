import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSchema } from "graphql";
import { describe, expect, it } from "vitest";

import { SENSOR_LIST_ENDPOINT_AVAILABLE } from "@/lib/detection";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/review.graphql");

const QUERY_FIELD = "customerSensorList";
const SENSOR_TYPE = "Sensor";
const SENSOR_NODE_ID_FIELD = "nodeId";

function schemaExposesSensorListContract(): {
  exposed: boolean;
  reason: string | null;
} {
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  const schema = buildSchema(sdl);
  const queryType = schema.getQueryType();
  if (!queryType) {
    return { exposed: false, reason: "schema has no Query type" };
  }
  if (!(QUERY_FIELD in queryType.getFields())) {
    return {
      exposed: false,
      reason: `Query.${QUERY_FIELD} is not defined`,
    };
  }
  const sensorType = schema.getType(SENSOR_TYPE);
  if (!sensorType || !("getFields" in sensorType)) {
    return {
      exposed: false,
      reason: `type ${SENSOR_TYPE} is not an object/interface type`,
    };
  }
  const sensorFields = (
    sensorType as {
      getFields: () => Record<string, { type: { toString(): string } }>;
    }
  ).getFields();
  const nodeIdField = sensorFields[SENSOR_NODE_ID_FIELD];
  if (!nodeIdField) {
    return {
      exposed: false,
      reason: `${SENSOR_TYPE}.${SENSOR_NODE_ID_FIELD} is not defined`,
    };
  }
  if (nodeIdField.type.toString() !== "ID!") {
    return {
      exposed: false,
      reason: `${SENSOR_TYPE}.${SENSOR_NODE_ID_FIELD} must be ID!, got ${nodeIdField.type.toString()}`,
    };
  }
  return { exposed: true, reason: null };
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
    // The matcher accepts the endpoint as "available" only when BOTH:
    //   - `Query.customerSensorList` exists, and
    //   - `Sensor.nodeId: ID!` exists.
    //
    // A pre-review-web-0.33.0 schema that exposed `customerSensorList`
    // without `Sensor.nodeId` (the old `agentKey` shape, per-agent grain)
    // would not satisfy the contract: the dispatch projects `nodeId`
    // into the public `Sensor.id` field, so a schema that lacks it
    // breaks the projection and must be treated as endpoint-absent.
    const { exposed, reason } = schemaExposesSensorListContract();
    if (exposed && !SENSOR_LIST_ENDPOINT_AVAILABLE) {
      throw new Error(
        "schemas/review.graphql now exposes the sensor-list endpoint " +
          `(Query.${QUERY_FIELD} + ${SENSOR_TYPE}.${SENSOR_NODE_ID_FIELD}), ` +
          "but SENSOR_LIST_ENDPOINT_AVAILABLE is still `false`. Flip " +
          "the constant in src/lib/detection/sensors.ts and wire the " +
          "inline `parse(...)` dispatch in the same PR.",
      );
    }
    if (!exposed && SENSOR_LIST_ENDPOINT_AVAILABLE) {
      throw new Error(
        "SENSOR_LIST_ENDPOINT_AVAILABLE is `true`, but " +
          `schemas/review.graphql does not satisfy the sensor-list ` +
          `contract: ${reason}. Either revert the constant or add the ` +
          "missing schema field in the same PR that vendored the new schema.",
      );
    }
    expect(SENSOR_LIST_ENDPOINT_AVAILABLE).toBe(exposed);
  });
});
