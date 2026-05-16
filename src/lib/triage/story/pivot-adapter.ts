/**
 * Adapter: Story-member detail row → {@link ScoredTriageEvent}.
 *
 * The Pivot Tier 1 client-side index (#452) builds against the
 * asset-events shape (`ScoredTriageEvent`) — the same shape the
 * `eventList` aggregator emits. The Pivot-from-Story drill-in (#553)
 * has to feed the index with Story members instead; this adapter
 * normalizes the {@link TriageStoryMemberDetail} row view-model into
 * the index's input contract without redefining a Story-only event
 * shape.
 *
 * Field coverage. The member detail row (`event_group_member ⨝
 * baseline_triaged_event` per #547) carries the network 5-tuple, the
 * application-layer scalars (`host`, `dnsQuery`, `uri`), the sensor,
 * and the kind / category labels. It does NOT carry TLS subtype
 * fields (ja3, ja3s, serverName, cert serial/CN), country codes,
 * user-agent, cluster id, SSH/SMB/FTP/LDAP/MQTT subtype scalars, or
 * the `level` ordinal — those columns are absent from
 * `baseline_triaged_event`. Pivot dimensions that read them yield no
 * focus value for Story-origin trails and the panel's
 * `buildPivotPanel` skips empty sections automatically (#452 AC). No
 * extra gating is needed in the adapter.
 *
 * `baselineScore: null` handling. The period-scoped LEFT JOIN
 * introduced by #547 leaves `baseline_score` null for members whose
 * `event_time` falls outside the menu period. The adapter maps
 * `null → score: 0` so the Tier 1 index's score-desc sort places
 * null-scored members at the bottom of their (dimension, value)
 * bucket deterministically (sort tie-break is newest-first, so they
 * are not silently dropped — they participate in grouping and surface
 * after non-null peers). This is the documented #553 acceptance for
 * "baseline_score = null participates correctly in Tier 1 pivots".
 */

import type { ThreatCategory } from "@/lib/detection";

import type { ScoredTriageEvent } from "../types";
import type { TriageStoryMemberDetail } from "./types";

const THREAT_CATEGORY_LITERALS: ReadonlySet<string> = new Set([
  "RECONNAISSANCE",
  "INITIAL_ACCESS",
  "EXECUTION",
  "CREDENTIAL_ACCESS",
  "DISCOVERY",
  "LATERAL_MOVEMENT",
  "COMMAND_AND_CONTROL",
  "EXFILTRATION",
  "IMPACT",
  "COLLECTION",
  "DEFENSE_EVASION",
  "PERSISTENCE",
  "PRIVILEGE_ESCALATION",
  "RESOURCE_DEVELOPMENT",
] as const satisfies readonly ThreatCategory[]);

function narrowCategory(
  value: ThreatCategory | string | null,
): ThreatCategory | null {
  if (value === null) return null;
  return THREAT_CATEGORY_LITERALS.has(value) ? (value as ThreatCategory) : null;
}

/**
 * Convert one Story member detail row into a `ScoredTriageEvent`
 * suitable for {@link buildPivotIndex}.
 *
 * `customerId` is supplied by the caller because the detail row
 * inherits its tenant from the Story header — it isn't carried on the
 * row itself. The synthetic `rowKey` carries the customer prefix so
 * downstream {@link resolveStepFocusEvents} filters on the explicit
 * `customerId` field rather than parsing this string.
 */
export function storyMemberToScoredEvent(
  member: TriageStoryMemberDetail,
  customerId: number,
): ScoredTriageEvent {
  return {
    __typename: member.kind,
    id: member.eventKey,
    time: member.eventTimeIso,
    sensor: member.sensor,
    category: narrowCategory(member.category),
    level: null,
    origAddr: member.origAddr,
    respAddr: member.respAddr,
    origPort: member.origPort,
    respPort: member.respPort,
    host: member.host,
    uri: member.uri,
    query: member.dnsQuery,
    // baselineScore null → 0 keeps the null-period row in the bucket
    // (sort places it last in its score band) without dropping it
    // from the grouping pass. See module docstring for the #553 AC.
    score: member.baselineScore ?? 0,
    customerId,
    // Carry the marker flag through to the pivot related-events panel
    // (#471 §3 / #596 Round 2 item 2). Story detail already computes
    // `member.protectedByStory` against the four-condition rule with
    // the active slider cutoff; pivot-from-Story renders the marker
    // directly from `event.protectedByStory`, so dropping it here
    // would silently un-mark protected members the moment the analyst
    // pivots from their Story.
    protectedByStory: member.protectedByStory,
    rowKey: `${customerId}/${member.eventKey}`,
  };
}

/**
 * Bulk variant: returns every member adapted in source order. The
 * pivot index sorts inside each bucket so the input order is not
 * load-bearing for the produced sections — preserved here only to
 * keep the "synthetic detail-panel events" cap deterministic.
 */
export function storyMembersToScoredEvents(
  members: readonly TriageStoryMemberDetail[],
  customerId: number,
): ScoredTriageEvent[] {
  return members.map((m) => storyMemberToScoredEvent(m, customerId));
}
