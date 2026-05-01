import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildSchema, type GraphQLSchema } from "graphql";

export type FixtureSchemaName = "review" | "giganto" | "tivan";

const SCHEMA_PATHS: Record<FixtureSchemaName, string> = {
  review: resolve(__dirname, "../../schemas/review.graphql"),
  giganto: resolve(__dirname, "../../schemas/giganto.graphql"),
  tivan: resolve(__dirname, "../../schemas/tivan.graphql"),
};

const cached = new Map<FixtureSchemaName, GraphQLSchema>();

export function loadSchema(schemaName: FixtureSchemaName): GraphQLSchema {
  const existing = cached.get(schemaName);
  if (existing) return existing;
  const sdl = readFileSync(SCHEMA_PATHS[schemaName], "utf8");
  const schema = buildSchema(sdl);
  cached.set(schemaName, schema);
  return schema;
}

export function loadReviewSchema(): GraphQLSchema {
  return loadSchema("review");
}

export function loadGigantoSchema(): GraphQLSchema {
  return loadSchema("giganto");
}

export function loadTivanSchema(): GraphQLSchema {
  return loadSchema("tivan");
}
