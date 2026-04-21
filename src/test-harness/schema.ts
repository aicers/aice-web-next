import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildSchema, type GraphQLSchema } from "graphql";

const SCHEMA_PATH = resolve(__dirname, "../../schemas/review.graphql");

let cached: GraphQLSchema | null = null;

export function loadReviewSchema(): GraphQLSchema {
  if (cached) return cached;
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  cached = buildSchema(sdl);
  return cached;
}
