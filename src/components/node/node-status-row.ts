import type { NodeStatus } from "@/lib/node/types";

export interface NodeStatusRowSnapshot {
  id: string;
  name: string;
  hostname: string;
  manager: boolean | null;
  ping: number | null;
  cpuUsage: number | null;
  totalMemory: string | null;
  usedMemory: string | null;
  totalDiskSpace: string | null;
  usedDiskSpace: string | null;
}

export function nodeStatusToRow(node: NodeStatus): NodeStatusRowSnapshot {
  return {
    id: node.id,
    name: node.nameDraft ?? node.name,
    hostname: node.profile?.hostname ?? node.profileDraft?.hostname ?? "",
    manager: node.manager,
    ping: node.ping,
    cpuUsage: node.cpuUsage,
    totalMemory: node.totalMemory,
    usedMemory: node.usedMemory,
    totalDiskSpace: node.totalDiskSpace,
    usedDiskSpace: node.usedDiskSpace,
  };
}
