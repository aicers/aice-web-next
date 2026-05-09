import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSchema,
  type DocumentNode,
  type FieldNode,
  type GraphQLObjectType,
  type GraphQLSchema,
  type InlineFragmentNode,
  isObjectType,
  Kind,
  type SelectionSetNode,
} from "graphql";
import { describe, expect, it } from "vitest";

import { TRIAGE_EVENT_LIST_QUERY } from "@/lib/triage/queries";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/review.graphql");

function loadSchema(): GraphQLSchema {
  return buildSchema(readFileSync(SCHEMA_PATH, "utf8"));
}

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

function objectType(schema: GraphQLSchema, name: string): GraphQLObjectType {
  const t = schema.getType(name);
  if (!t || !isObjectType(t)) {
    throw new Error(`schema does not define object type ${name}`);
  }
  return t;
}

function exposesField(t: GraphQLObjectType, fieldName: string): boolean {
  return Object.hasOwn(t.getFields(), fieldName);
}

describe("TRIAGE_EVENT_LIST_QUERY", () => {
  const schema = loadSchema();
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

  // Pivot dimensions defined in #476 §1: per-subtype the query must
  // select every one of these that the schema actually defines on
  // that subtype. Coverage is uneven (RdpBruteForce has no resp side
  // at all; MultiHostPortScan / PortScan / FtpBruteForce /
  // LdapBruteForce are missing one or more of origPort / respAddr /
  // respCountry), so the test consults the schema to decide what
  // each fragment must select rather than asserting a uniform list.
  const NETWORK_DIMENSION_FIELDS = [
    "respAddr",
    "origPort",
    "respPort",
    "origCountry",
    "respCountry",
    "origNetwork",
    "respNetwork",
  ] as const;

  // HTTP-shaped subtypes: only these four get host/uri/userAgent in
  // 1A-1.1, even though the schema may expose those fields on other
  // subtypes (e.g. TorConnection). RepeatedHttpSessions is the
  // intentionally-skipped HTTP subtype — see issue.
  const HTTP_ALLOWLIST = [
    "BlocklistHttp",
    "HttpThreat",
    "NonBrowser",
    "DomainGenerationAlgorithm",
  ] as const;
  const HTTP_FIELDS = ["host", "uri", "userAgent"] as const;

  const DNS_ALLOWLIST = [
    "BlocklistDns",
    "DnsCovertChannel",
    "CryptocurrencyMiningPool",
    "LockyRansomware",
  ] as const;
  const DNS_FIELDS = ["query", "answer"] as const;

  const TLS_ALLOWLIST = ["BlocklistTls", "SuspiciousTlsTraffic"] as const;
  const TLS_FIELDS = [
    "ja3",
    "ja3S",
    "serverName",
    "serial",
    "subjectCommonName",
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

  describe("network pivot dimensions", () => {
    for (const subtype of REQUIRED_WHITELIST_SUBTYPES) {
      describe(subtype, () => {
        const obj = objectType(schema, subtype);
        const fragment = inlineFragmentFor(nodesSelectionSet, subtype);
        for (const field of NETWORK_DIMENSION_FIELDS) {
          const exposes = exposesField(obj, field);
          if (exposes) {
            it(`selects ${field} (schema exposes it)`, () => {
              expect(fragment).toBeDefined();
              expect(fragment && selectsField(fragment, field)).toBe(true);
            });
          } else {
            it(`does not select ${field} (schema does not expose it)`, () => {
              expect(fragment).toBeDefined();
              expect(fragment && selectsField(fragment, field)).toBe(false);
            });
          }
        }
      });
    }
  });

  describe("HTTP-shaped pivot fields", () => {
    for (const subtype of HTTP_ALLOWLIST) {
      it.each(HTTP_FIELDS)(`selects %s on ${subtype}`, (field) => {
        const fragment = inlineFragmentFor(nodesSelectionSet, subtype);
        expect(fragment).toBeDefined();
        expect(fragment && selectsField(fragment, field)).toBe(true);
      });
    }

    it.each(
      HTTP_FIELDS,
    )("does not select %s on RepeatedHttpSessions (intentionally skipped)", (field) => {
      const fragment = inlineFragmentFor(
        nodesSelectionSet,
        "RepeatedHttpSessions",
      );
      expect(fragment).toBeDefined();
      expect(fragment && selectsField(fragment, field)).toBe(false);
    });
  });

  describe("DNS-shaped pivot fields", () => {
    for (const subtype of DNS_ALLOWLIST) {
      it.each(DNS_FIELDS)(`selects %s on ${subtype}`, (field) => {
        const fragment = inlineFragmentFor(nodesSelectionSet, subtype);
        expect(fragment).toBeDefined();
        expect(fragment && selectsField(fragment, field)).toBe(true);
      });
    }

    it.each(
      DNS_FIELDS,
    )("does not select %s on BlocklistMalformedDns (no payload)", (field) => {
      const fragment = inlineFragmentFor(
        nodesSelectionSet,
        "BlocklistMalformedDns",
      );
      expect(fragment).toBeDefined();
      expect(fragment && selectsField(fragment, field)).toBe(false);
    });
  });

  describe("TLS-shaped pivot fields", () => {
    for (const subtype of TLS_ALLOWLIST) {
      it.each(TLS_FIELDS)(`selects %s on ${subtype}`, (field) => {
        const fragment = inlineFragmentFor(nodesSelectionSet, subtype);
        expect(fragment).toBeDefined();
        expect(fragment && selectsField(fragment, field)).toBe(true);
      });
    }
  });
});
