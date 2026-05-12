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

/**
 * `true` when the fragment selects a top-level field whose response
 * key (alias if present, otherwise the field name) matches
 * {@link responseKey}. The #503 per-protocol identifier selections use
 * aliases (e.g. `sshClient: client`) so the type field stays generic
 * but the TriageEvent property has the protocol-prefixed name.
 */
function selectsAlias(node: InlineFragmentNode, responseKey: string): boolean {
  return node.selectionSet.selections.some(
    (s): s is FieldNode =>
      s.kind === Kind.FIELD &&
      (s.alias ? s.alias.value : s.name.value) === responseKey,
  );
}

/**
 * `true` when the fragment selects {@link parentResponseKey} and that
 * selection nests {@link childFieldName}. Used by the FTP `ftpCommands`
 * assertion to verify the query selects the nested `command` scalar
 * — selecting the bare composite `commands` is a GraphQL error.
 */
function selectsNestedField(
  node: InlineFragmentNode,
  parentResponseKey: string,
  childFieldName: string,
): boolean {
  for (const sel of node.selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    const key = sel.alias ? sel.alias.value : sel.name.value;
    if (key !== parentResponseKey) continue;
    if (!sel.selectionSet) return false;
    return sel.selectionSet.selections.some(
      (c): c is FieldNode =>
        c.kind === Kind.FIELD && c.name.value === childFieldName,
    );
  }
  return false;
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

  it("selects `id` at the interface level so every subtype carries it", () => {
    // `id` is required on the `Event` interface (review-web 0.32.0 /
    // review 0.49.0). Selecting it once at the nodes root covers every
    // concrete subtype — no per-fragment edit needed — and the Tier 2
    // dedupe key collapses repeats by identity rather than by the
    // earlier `(typename, time, addresses, ports)` composite.
    const rootIdField = nodesSelectionSet.selections.find(
      (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === "id",
    );
    expect(rootIdField).toBeDefined();
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

  describe("per-protocol identifier pivot fields (#503 sub-item A)", () => {
    // SSH (BlocklistSsh). Aliased response keys: `sshClient`,
    // `sshServer`, `sshHassh`, `sshHasshServer` over the SDL's
    // `client`, `server`, `hassh`, `hasshServer`.
    const SSH_ALIASES = [
      "sshClient",
      "sshServer",
      "sshHassh",
      "sshHasshServer",
    ] as const;
    it.each(SSH_ALIASES)("selects %s alias on BlocklistSsh", (alias) => {
      const fragment = inlineFragmentFor(nodesSelectionSet, "BlocklistSsh");
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, alias)).toBe(true);
    });

    // SMB (BlocklistSmb). Aliased response keys: `smbPath`,
    // `smbService`, `smbFileName`.
    const SMB_ALIASES = ["smbPath", "smbService", "smbFileName"] as const;
    it.each(SMB_ALIASES)("selects %s alias on BlocklistSmb", (alias) => {
      const fragment = inlineFragmentFor(nodesSelectionSet, "BlocklistSmb");
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, alias)).toBe(true);
    });

    // FTP `commands { command }` — `BlocklistFtp` and `FtpPlainText`
    // expose the composite `[FtpCommand!]!` field; the query selects
    // the nested `command` scalar under the aliased `ftpCommands`
    // response key. Selecting the bare composite would be a GraphQL
    // error, so the assertion verifies both the alias presence and the
    // nested `command` subfield.
    const FTP_COMMANDS_SUBTYPES = ["BlocklistFtp", "FtpPlainText"] as const;
    it.each(
      FTP_COMMANDS_SUBTYPES,
    )("selects ftpCommands { command } on %s", (typeName) => {
      const fragment = inlineFragmentFor(nodesSelectionSet, typeName);
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, "ftpCommands")).toBe(true);
      expect(
        fragment && selectsNestedField(fragment, "ftpCommands", "command"),
      ).toBe(true);
    });

    // FtpBruteForce does not carry `commands` in the SDL, so the
    // selection must NOT include `ftpCommands` on its fragment — a
    // GraphQL field-not-defined error would otherwise reject the query
    // at parse time on REview.
    it("does not select ftpCommands on FtpBruteForce", () => {
      const fragment = inlineFragmentFor(nodesSelectionSet, "FtpBruteForce");
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, "ftpCommands")).toBe(false);
    });

    // LDAP string-list fields. Aliased response keys: `ldapOpcode`,
    // `ldapObject`, `ldapArgument`.
    const LDAP_SUBTYPES = ["BlocklistLdap", "LdapPlainText"] as const;
    const LDAP_ALIASES = ["ldapOpcode", "ldapObject", "ldapArgument"] as const;
    for (const subtype of LDAP_SUBTYPES) {
      it.each(LDAP_ALIASES)(`selects %s alias on ${subtype}`, (alias) => {
        const fragment = inlineFragmentFor(nodesSelectionSet, subtype);
        expect(fragment).toBeDefined();
        expect(fragment && selectsAlias(fragment, alias)).toBe(true);
      });
    }

    it.each(
      LDAP_ALIASES,
    )("does not select %s alias on LdapBruteForce", (alias) => {
      const fragment = inlineFragmentFor(nodesSelectionSet, "LdapBruteForce");
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, alias)).toBe(false);
    });

    // MQTT (BlocklistMqtt). Aliased response key: `mqttSubscribe`.
    it("selects mqttSubscribe alias on BlocklistMqtt", () => {
      const fragment = inlineFragmentFor(nodesSelectionSet, "BlocklistMqtt");
      expect(fragment).toBeDefined();
      expect(fragment && selectsAlias(fragment, "mqttSubscribe")).toBe(true);
    });
  });
});
