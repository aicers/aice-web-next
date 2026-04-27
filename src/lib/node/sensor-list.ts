import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";

import { listAllNodes } from "./server-actions";
import type { Node as ManagerNode } from "./types";

/**
 * A flat sensor-bearing node row used by Hog's `active_sensors` checkbox
 * list. Identity is the node id; the hostname comes from `profileDraft`
 * when available so the operator sees pending edits, falling back to
 * the applied `profile`.
 */
export interface SensorNodeOption {
  id: string;
  name: string;
  hostname: string | null;
}

/**
 * Return de-duplicated nodes whose `agents` contain a `SENSOR` agent
 * kind, drawn from every page of the manager's `nodeList` connection.
 *
 * Why this query (not `sensorList`): Phase Detection-24 still blocks
 * the `sensorList` query on REview, and the manager-driven view of
 * "what nodes carry a sensor right now" lives on `nodeList`. Each
 * node may carry multiple agents; we filter to the SENSOR kind. The
 * list is de-duplicated by node id so a node that appears on multiple
 * pages of the cursor walk (possible if pagination races a write)
 * still shows up once in the checkbox set.
 *
 * The `nodeList` cursor walk itself is centralised in
 * {@link listAllNodes}, which pages until `pageInfo.hasNextPage ===
 * false` and is covered by `server-actions.test.ts`. This wrapper
 * adds the SENSOR-kind filter and the de-dup pass. Server-side only:
 * `listAllNodes` already enforces `nodes:read` + `services:read`.
 */
export async function listSensorNodes(
  session: AuthSession,
  signal?: AbortSignal,
): Promise<SensorNodeOption[]> {
  const connection = await listAllNodes(session, signal);
  return collectSensorNodes(connection.edges.map((e) => e.node));
}

export function collectSensorNodes(nodes: ManagerNode[]): SensorNodeOption[] {
  const seen = new Set<string>();
  const out: SensorNodeOption[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    if (!node.agents.some((a) => a.kind === "SENSOR")) continue;
    seen.add(node.id);
    out.push({
      id: node.id,
      name: node.nameDraft ?? node.name,
      hostname: node.profileDraft?.hostname ?? node.profile?.hostname ?? null,
    });
  }
  return out;
}
