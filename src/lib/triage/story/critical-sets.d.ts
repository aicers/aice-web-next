// Type declarations for `critical-sets.mjs`. Authored as a sibling
// `.d.ts` so the TS callers re-exporting these constants get IDE /
// typecheck signal without forcing the runtime module through a
// transpile step.

import type { ThreatCategory } from "@/lib/detection";

export const CRITICAL_CATEGORIES: ReadonlySet<ThreatCategory>;
export const CRITICAL_SELECTOR_SET: ReadonlySet<string>;
