import {
  type DocumentNode,
  type FieldNode,
  type InlineFragmentNode,
  Kind,
  type SelectionSetNode,
} from "graphql";
import { describe, expect, it } from "vitest";

import { TRIAGE_EVENT_LIST_QUERY } from "@/lib/triage/queries";

function findEventListSelectionSet(doc: DocumentNode): SelectionSetNode {
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of def.selectionSet.selections) {
      if (
        selection.kind === Kind.FIELD &&
        selection.name.value === "eventList" &&
        selection.selectionSet
      ) {
        for (const inner of selection.selectionSet.selections) {
          if (
            inner.kind === Kind.FIELD &&
            inner.name.value === "nodes" &&
            inner.selectionSet
          ) {
            return inner.selectionSet;
          }
        }
      }
    }
  }
  throw new Error("eventList.nodes selection set not found");
}

function inlineFragmentFor(
  selectionSet: SelectionSetNode,
  typeName: string,
): InlineFragmentNode | undefined {
  return selectionSet.selections.find(
    (s): s is InlineFragmentNode =>
      s.kind === Kind.INLINE_FRAGMENT &&
      s.typeCondition?.name.value === typeName,
  );
}

function selectsField(node: InlineFragmentNode, fieldName: string): boolean {
  return node.selectionSet.selections.some(
    (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === fieldName,
  );
}

describe("TRIAGE_EVENT_LIST_QUERY", () => {
  const nodesSelectionSet = findEventListSelectionSet(TRIAGE_EVENT_LIST_QUERY);

  // Subtypes that expose `origAddr` and whose category falls inside the
  // baseline whitelist (CommandAndControl, Exfiltration, Impact,
  // InitialAccess, CredentialAccess). If any of these is missing from
  // the selection set, `aggregateTriageEvents` will silently drop those
  // events from the asset list / detail panel even though they would
  // count toward the funnel — exactly the under-ranking the reviewer
  // flagged for `RdpBruteForce`.
  const REQUIRED_WHITELIST_SUBTYPES = [
    "BlocklistBootp",
    "BlocklistConn",
    "BlocklistDceRpc",
    "BlocklistDhcp",
    "BlocklistDns",
    "BlocklistFtp",
    "BlocklistHttp",
    "BlocklistKerberos",
    "BlocklistLdap",
    "BlocklistMalformedDns",
    "BlocklistMqtt",
    "BlocklistNfs",
    "BlocklistNtlm",
    "BlocklistRadius",
    "BlocklistRdp",
    "BlocklistSmb",
    "BlocklistSmtp",
    "BlocklistSsh",
    "BlocklistTls",
    "CryptocurrencyMiningPool",
    "DnsCovertChannel",
    "DomainGenerationAlgorithm",
    "FtpBruteForce",
    "FtpPlainText",
    "HttpThreat",
    "LdapBruteForce",
    "LdapPlainText",
    "LockyRansomware",
    "MultiHostPortScan",
    "NetworkThreat",
    "NonBrowser",
    "PortScan",
    "RdpBruteForce",
    "RepeatedHttpSessions",
    "SuspiciousTlsTraffic",
    "TorConnection",
    "TorConnectionConn",
  ] as const;

  it.each(
    REQUIRED_WHITELIST_SUBTYPES,
  )("selects origAddr on the %s inline fragment", (typeName) => {
    const fragment = inlineFragmentFor(nodesSelectionSet, typeName);
    expect(fragment, `${typeName} fragment is present`).toBeDefined();
    expect(
      fragment && selectsField(fragment, "origAddr"),
      `${typeName} fragment selects origAddr`,
    ).toBe(true);
  });

  it("selects clusterId on HttpThreat for the cluster-none bonus", () => {
    const fragment = inlineFragmentFor(nodesSelectionSet, "HttpThreat");
    expect(fragment).toBeDefined();
    expect(fragment && selectsField(fragment, "clusterId")).toBe(true);
  });
});
