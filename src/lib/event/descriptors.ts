/**
 * Descriptor-driven mapping for every Event-menu record type.
 *
 * The 20 Giganto network raw-event types share a common header but
 * diverge widely in their type-specific fields. Rather than hand-write a
 * bespoke table + detail component per type, each type is described once
 * here as an ordered list of `{ key, scalar }` field descriptors plus a
 * curated `summaryKeys` subset for the results table. One generic table
 * and one generic detail sheet render any type off its descriptor.
 *
 * The `scalar` kind is the single source of truth for how a field is
 * rendered **and** how it is typed. The {@link FieldDescriptor} mapped
 * type pins each field's `scalar` to a value consistent with that
 * field's TypeScript type in `types.ts`: a `StringNumber*` scalar
 * (`u64` / `i64` / `u32` / `usize`) is only assignable to a `string`
 * property, so a field that `types.ts` accidentally typed as `number`
 * cannot carry a `StringNumber*` scalar — `pnpm typecheck` rejects it.
 * The parametrized descriptor test then cross-checks the same invariant
 * against the fixtures at runtime.
 */

import type { RecordTypeId } from "./record-types";
import type {
  BootpRawEvent,
  ConnRawEvent,
  DceRpcContextRawEvent,
  DceRpcRawEvent,
  DhcpOptionRawEvent,
  DhcpRawEvent,
  DnsRawEvent,
  FtpCommandRawEvent,
  FtpRawEvent,
  HttpRawEvent,
  IcmpRawEvent,
  KerberosRawEvent,
  LdapRawEvent,
  MalformedDnsRawEvent,
  MqttRawEvent,
  NfsRawEvent,
  NtlmRawEvent,
  RadiusRawEvent,
  RdpRawEvent,
  SmbRawEvent,
  SmtpRawEvent,
  SshRawEvent,
  TlsRawEvent,
} from "./types";

/**
 * The scalar shape of a record field, after Giganto serialization. The
 * four `StringNumber*` kinds are returned as strings (never JS numbers);
 * the three `sub:*` kinds are nested sub-record arrays.
 */
export type ScalarKind =
  | "string"
  | "datetime"
  | "int"
  | "bool"
  | "u64"
  | "i64"
  | "u32"
  | "usize"
  | "stringList"
  | "intList"
  | "intMatrix"
  | "sub:dceRpcContext"
  | "sub:ftpCommand"
  | "sub:dhcpOption";

/** The four `StringNumber*` scalar kinds, all typed `string`. */
export const STRING_NUMBER_KINDS: ReadonlySet<ScalarKind> = new Set([
  "u64",
  "i64",
  "u32",
  "usize",
]);

/** Optional per-field rendering override. */
export type FieldFormat = "proto" | "duration";

/**
 * Maps a field's TypeScript type to the `ScalarKind`(s) it may declare.
 * A `string` property may be any of the string-serialized kinds
 * (including the `StringNumber*` ones), a `number` is `int`, and so on.
 * `boolean` is matched before `string` because it is not a `string`.
 */
type TsToScalar<V> = [V] extends [boolean]
  ? "bool"
  : [V] extends [string]
    ? "string" | "datetime" | "u64" | "i64" | "u32" | "usize"
    : [V] extends [number]
      ? "int"
      : [V] extends [string[]]
        ? "stringList"
        : [V] extends [number[][]]
          ? "intMatrix"
          : [V] extends [number[]]
            ? "intList"
            : [V] extends [DceRpcContextRawEvent[]]
              ? "sub:dceRpcContext"
              : [V] extends [FtpCommandRawEvent[]]
                ? "sub:ftpCommand"
                : [V] extends [DhcpOptionRawEvent[]]
                  ? "sub:dhcpOption"
                  : never;

/**
 * A type-checked field descriptor for record `T`: `key` must be a field
 * of `T`, and `scalar` must be consistent with that field's type. Built
 * as a union over the keys of `T` so the `key`/`scalar` pairing is
 * enforced per field.
 */
export type FieldDescriptor<T> = {
  [K in keyof T & string]: {
    key: K;
    scalar: TsToScalar<T[K]>;
    format?: FieldFormat;
  };
}[keyof T & string];

/** Sub-records reuse the same descriptor shape (no nested `sub:*`). */
export type SubFieldDescriptor<T> = FieldDescriptor<T>;

/**
 * Runtime-facing (generics-erased) field descriptor. Every
 * `FieldDescriptor<T>` widens to this, so the registry can hold all 20
 * types in one map while authoring stays type-checked.
 */
export interface AnyFieldDescriptor {
  key: string;
  scalar: ScalarKind;
  format?: FieldFormat;
}

/**
 * Client-safe description of a record type: its header shape, fields,
 * and curated table columns. The GraphQL `DocumentNode` is intentionally
 * **not** here — it is loaded from disk in the server-only `queries.ts`
 * (`RAW_EVENT_QUERIES`), so this module stays importable from client
 * components (the results table / detail sheet) without dragging
 * `node:fs` into the browser bundle. The `responseKey` links the two.
 */
export interface RecordDescriptor {
  id: RecordTypeId;
  /** The `<type>RawEvents` field name in the query response envelope. */
  responseKey: string;
  /**
   * Whether the type carries `origPort` / `respPort`. Icmp does not, so
   * the filter strips port inputs and the table renders bare addresses.
   */
  hasPorts: boolean;
  fields: AnyFieldDescriptor[];
  /** Field keys shown as table columns beyond the common leading set. */
  summaryKeys: string[];
}

const connFields: FieldDescriptor<ConnRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "connState", scalar: "string" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "service", scalar: "string" },
  { key: "origBytes", scalar: "u64" },
  { key: "respBytes", scalar: "u64" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
];

const dnsFields: FieldDescriptor<DnsRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "query", scalar: "string" },
  { key: "answer", scalar: "stringList" },
  { key: "transId", scalar: "int" },
  { key: "rtt", scalar: "i64", format: "duration" },
  { key: "qclass", scalar: "int" },
  { key: "qtype", scalar: "int" },
  { key: "rcode", scalar: "int" },
  { key: "aaFlag", scalar: "bool" },
  { key: "tcFlag", scalar: "bool" },
  { key: "rdFlag", scalar: "bool" },
  { key: "raFlag", scalar: "bool" },
  { key: "ttl", scalar: "intList" },
];

const malformedDnsFields: FieldDescriptor<MalformedDnsRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "transId", scalar: "int" },
  { key: "flags", scalar: "int" },
  { key: "questionCount", scalar: "int" },
  { key: "answerCount", scalar: "int" },
  { key: "authorityCount", scalar: "int" },
  { key: "additionalCount", scalar: "int" },
  { key: "queryCount", scalar: "u32" },
  { key: "respCount", scalar: "u32" },
  { key: "queryBytes", scalar: "u64" },
  { key: "respBytes", scalar: "u64" },
  { key: "queryBody", scalar: "intMatrix" },
  { key: "respBody", scalar: "intMatrix" },
];

const httpFields: FieldDescriptor<HttpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "method", scalar: "string" },
  { key: "host", scalar: "string" },
  { key: "uri", scalar: "string" },
  { key: "referer", scalar: "string" },
  { key: "version", scalar: "string" },
  { key: "userAgent", scalar: "string" },
  { key: "requestLen", scalar: "usize" },
  { key: "responseLen", scalar: "usize" },
  { key: "statusCode", scalar: "int" },
  { key: "statusMsg", scalar: "string" },
  { key: "username", scalar: "string" },
  { key: "password", scalar: "string" },
  { key: "cookie", scalar: "string" },
  { key: "contentEncoding", scalar: "string" },
  { key: "contentType", scalar: "string" },
  { key: "cacheControl", scalar: "string" },
  { key: "filenames", scalar: "stringList" },
  { key: "mimeTypes", scalar: "stringList" },
  { key: "body", scalar: "intList" },
  { key: "state", scalar: "string" },
];

const rdpFields: FieldDescriptor<RdpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "cookie", scalar: "string" },
];

const smtpFields: FieldDescriptor<SmtpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "mailfrom", scalar: "string" },
  { key: "date", scalar: "string" },
  { key: "from", scalar: "string" },
  { key: "to", scalar: "string" },
  { key: "subject", scalar: "string" },
  { key: "agent", scalar: "string" },
  { key: "state", scalar: "string" },
];

const ntlmFields: FieldDescriptor<NtlmRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "username", scalar: "string" },
  { key: "hostname", scalar: "string" },
  { key: "domainname", scalar: "string" },
  { key: "success", scalar: "string" },
  { key: "protocol", scalar: "string" },
];

const kerberosFields: FieldDescriptor<KerberosRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "clientTime", scalar: "i64" },
  { key: "serverTime", scalar: "i64" },
  { key: "errorCode", scalar: "u32" },
  { key: "clientRealm", scalar: "string" },
  { key: "cnameType", scalar: "int" },
  { key: "cname", scalar: "stringList" },
  { key: "realm", scalar: "string" },
  { key: "snameType", scalar: "int" },
  { key: "sname", scalar: "stringList" },
];

const sshFields: FieldDescriptor<SshRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "client", scalar: "string" },
  { key: "server", scalar: "string" },
  { key: "cipherAlg", scalar: "string" },
  { key: "macAlg", scalar: "string" },
  { key: "compressionAlg", scalar: "string" },
  { key: "kexAlg", scalar: "string" },
  { key: "hostKeyAlg", scalar: "string" },
  { key: "hasshAlgorithms", scalar: "string" },
  { key: "hassh", scalar: "string" },
  { key: "hasshServerAlgorithms", scalar: "string" },
  { key: "hasshServer", scalar: "string" },
  { key: "clientShka", scalar: "string" },
  { key: "serverShka", scalar: "string" },
];

const dceRpcFields: FieldDescriptor<DceRpcRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "context", scalar: "sub:dceRpcContext" },
  { key: "request", scalar: "stringList" },
];

const ftpFields: FieldDescriptor<FtpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "user", scalar: "string" },
  { key: "password", scalar: "string" },
  { key: "commands", scalar: "sub:ftpCommand" },
];

const mqttFields: FieldDescriptor<MqttRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "protocol", scalar: "string" },
  { key: "version", scalar: "int" },
  { key: "clientId", scalar: "string" },
  { key: "connackReason", scalar: "int" },
  { key: "subscribe", scalar: "stringList" },
  { key: "subackReason", scalar: "intList" },
];

const ldapFields: FieldDescriptor<LdapRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "messageId", scalar: "u32" },
  { key: "version", scalar: "int" },
  { key: "opcode", scalar: "stringList" },
  { key: "result", scalar: "stringList" },
  { key: "diagnosticMessage", scalar: "stringList" },
  { key: "object", scalar: "stringList" },
  { key: "argument", scalar: "stringList" },
];

const tlsFields: FieldDescriptor<TlsRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "serverName", scalar: "string" },
  { key: "alpnProtocol", scalar: "string" },
  { key: "ja3", scalar: "string" },
  { key: "version", scalar: "string" },
  { key: "clientCipherSuites", scalar: "intList" },
  { key: "clientExtensions", scalar: "intList" },
  { key: "cipher", scalar: "int" },
  { key: "extensions", scalar: "intList" },
  { key: "ja3S", scalar: "string" },
  { key: "serial", scalar: "string" },
  { key: "subjectCountry", scalar: "string" },
  { key: "subjectOrgName", scalar: "string" },
  { key: "subjectCommonName", scalar: "string" },
  { key: "validityNotBefore", scalar: "i64" },
  { key: "validityNotAfter", scalar: "i64" },
  { key: "subjectAltName", scalar: "string" },
  { key: "issuerCountry", scalar: "string" },
  { key: "issuerOrgName", scalar: "string" },
  { key: "issuerOrgUnitName", scalar: "string" },
  { key: "issuerCommonName", scalar: "string" },
  { key: "lastAlert", scalar: "int" },
];

const smbFields: FieldDescriptor<SmbRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "command", scalar: "int" },
  { key: "path", scalar: "string" },
  { key: "service", scalar: "string" },
  { key: "fileName", scalar: "string" },
  { key: "fileSize", scalar: "u64" },
  { key: "resourceType", scalar: "int" },
  { key: "fid", scalar: "int" },
  { key: "createTime", scalar: "i64" },
  { key: "accessTime", scalar: "i64" },
  { key: "writeTime", scalar: "i64" },
  { key: "changeTime", scalar: "i64" },
];

const nfsFields: FieldDescriptor<NfsRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "readFiles", scalar: "stringList" },
  { key: "writeFiles", scalar: "stringList" },
];

const bootpFields: FieldDescriptor<BootpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "op", scalar: "int" },
  { key: "htype", scalar: "int" },
  { key: "hops", scalar: "int" },
  { key: "xid", scalar: "u32" },
  { key: "ciaddr", scalar: "string" },
  { key: "yiaddr", scalar: "string" },
  { key: "siaddr", scalar: "string" },
  { key: "giaddr", scalar: "string" },
  { key: "chaddr", scalar: "intList" },
  { key: "sname", scalar: "string" },
  { key: "file", scalar: "string" },
];

const dhcpFields: FieldDescriptor<DhcpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "msgType", scalar: "int" },
  { key: "ciaddr", scalar: "string" },
  { key: "yiaddr", scalar: "string" },
  { key: "siaddr", scalar: "string" },
  { key: "giaddr", scalar: "string" },
  { key: "subnetMask", scalar: "string" },
  { key: "router", scalar: "stringList" },
  { key: "domainNameServer", scalar: "stringList" },
  { key: "reqIpAddr", scalar: "string" },
  { key: "leaseTime", scalar: "u32" },
  { key: "serverId", scalar: "string" },
  { key: "paramReqList", scalar: "intList" },
  { key: "message", scalar: "string" },
  { key: "renewalTime", scalar: "u32" },
  { key: "rebindingTime", scalar: "u32" },
  { key: "classId", scalar: "intList" },
  { key: "clientIdType", scalar: "int" },
  { key: "clientId", scalar: "intList" },
  { key: "options", scalar: "sub:dhcpOption" },
];

const radiusFields: FieldDescriptor<RadiusRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "origPort", scalar: "int" },
  { key: "respAddr", scalar: "string" },
  { key: "respPort", scalar: "int" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "id", scalar: "int" },
  { key: "code", scalar: "int" },
  { key: "respCode", scalar: "int" },
  { key: "auth", scalar: "string" },
  { key: "respAuth", scalar: "string" },
  { key: "userName", scalar: "intList" },
  { key: "userPasswd", scalar: "intList" },
  { key: "chapPasswd", scalar: "intList" },
  { key: "nasIp", scalar: "string" },
  { key: "nasPort", scalar: "u32" },
  { key: "state", scalar: "intList" },
  { key: "nasId", scalar: "intList" },
  { key: "nasPortType", scalar: "u32" },
  { key: "message", scalar: "string" },
];

const icmpFields: FieldDescriptor<IcmpRawEvent>[] = [
  { key: "time", scalar: "datetime" },
  { key: "origAddr", scalar: "string" },
  { key: "respAddr", scalar: "string" },
  { key: "proto", scalar: "int", format: "proto" },
  { key: "startTime", scalar: "datetime" },
  { key: "duration", scalar: "i64", format: "duration" },
  { key: "origPkts", scalar: "u64" },
  { key: "respPkts", scalar: "u64" },
  { key: "origL2Bytes", scalar: "u64" },
  { key: "respL2Bytes", scalar: "u64" },
  { key: "icmpType", scalar: "int" },
  { key: "icmpCode", scalar: "int" },
  { key: "id", scalar: "int" },
  { key: "seqNum", scalar: "int" },
  { key: "dataLen", scalar: "int" },
  { key: "payload", scalar: "intList" },
];

const dceRpcContextFields: SubFieldDescriptor<DceRpcContextRawEvent>[] = [
  { key: "id", scalar: "int" },
  { key: "abstractSyntax", scalar: "string" },
  { key: "abstractMajor", scalar: "int" },
  { key: "abstractMinor", scalar: "int" },
  { key: "transferSyntax", scalar: "string" },
  { key: "transferMajor", scalar: "int" },
  { key: "transferMinor", scalar: "int" },
  { key: "acceptance", scalar: "int" },
  { key: "reason", scalar: "int" },
];

const ftpCommandFields: SubFieldDescriptor<FtpCommandRawEvent>[] = [
  { key: "command", scalar: "string" },
  { key: "replyCode", scalar: "string" },
  { key: "replyMsg", scalar: "string" },
  { key: "dataPassive", scalar: "bool" },
  { key: "dataOrigAddr", scalar: "string" },
  { key: "dataRespAddr", scalar: "string" },
  { key: "dataRespPort", scalar: "int" },
  { key: "file", scalar: "string" },
  { key: "fileSize", scalar: "u64" },
  { key: "fileId", scalar: "string" },
];

const dhcpOptionFields: SubFieldDescriptor<DhcpOptionRawEvent>[] = [
  { key: "code", scalar: "int" },
  { key: "value", scalar: "intList" },
];

export const RECORD_DESCRIPTORS: Record<RecordTypeId, RecordDescriptor> = {
  conn: {
    id: "conn",
    responseKey: "connRawEvents",
    hasPorts: true,
    fields: connFields,
    summaryKeys: ["connState", "service", "origBytes", "respBytes"],
  },
  dns: {
    id: "dns",
    responseKey: "dnsRawEvents",
    hasPorts: true,
    fields: dnsFields,
    summaryKeys: ["query", "answer", "qtype", "rcode"],
  },
  malformedDns: {
    id: "malformedDns",
    responseKey: "malformedDnsRawEvents",
    hasPorts: true,
    fields: malformedDnsFields,
    summaryKeys: [
      "transId",
      "questionCount",
      "answerCount",
      "queryCount",
      "respCount",
    ],
  },
  http: {
    id: "http",
    responseKey: "httpRawEvents",
    hasPorts: true,
    fields: httpFields,
    summaryKeys: ["method", "host", "uri", "statusCode"],
  },
  rdp: {
    id: "rdp",
    responseKey: "rdpRawEvents",
    hasPorts: true,
    fields: rdpFields,
    summaryKeys: ["cookie"],
  },
  smtp: {
    id: "smtp",
    responseKey: "smtpRawEvents",
    hasPorts: true,
    fields: smtpFields,
    summaryKeys: ["mailfrom", "from", "to", "subject"],
  },
  ntlm: {
    id: "ntlm",
    responseKey: "ntlmRawEvents",
    hasPorts: true,
    fields: ntlmFields,
    summaryKeys: ["username", "hostname", "domainname", "success"],
  },
  kerberos: {
    id: "kerberos",
    responseKey: "kerberosRawEvents",
    hasPorts: true,
    fields: kerberosFields,
    summaryKeys: ["clientRealm", "cname", "sname"],
  },
  ssh: {
    id: "ssh",
    responseKey: "sshRawEvents",
    hasPorts: true,
    fields: sshFields,
    summaryKeys: ["client", "server", "cipherAlg", "kexAlg"],
  },
  dceRpc: {
    id: "dceRpc",
    responseKey: "dceRpcRawEvents",
    hasPorts: true,
    fields: dceRpcFields,
    summaryKeys: ["request", "context"],
  },
  ftp: {
    id: "ftp",
    responseKey: "ftpRawEvents",
    hasPorts: true,
    fields: ftpFields,
    summaryKeys: ["user", "commands"],
  },
  mqtt: {
    id: "mqtt",
    responseKey: "mqttRawEvents",
    hasPorts: true,
    fields: mqttFields,
    summaryKeys: ["protocol", "clientId", "connackReason"],
  },
  ldap: {
    id: "ldap",
    responseKey: "ldapRawEvents",
    hasPorts: true,
    fields: ldapFields,
    summaryKeys: ["messageId", "opcode", "result"],
  },
  tls: {
    id: "tls",
    responseKey: "tlsRawEvents",
    hasPorts: true,
    fields: tlsFields,
    summaryKeys: ["serverName", "version", "cipher", "ja3"],
  },
  smb: {
    id: "smb",
    responseKey: "smbRawEvents",
    hasPorts: true,
    fields: smbFields,
    summaryKeys: ["command", "path", "service", "fileName"],
  },
  nfs: {
    id: "nfs",
    responseKey: "nfsRawEvents",
    hasPorts: true,
    fields: nfsFields,
    summaryKeys: ["readFiles", "writeFiles"],
  },
  bootp: {
    id: "bootp",
    responseKey: "bootpRawEvents",
    hasPorts: true,
    fields: bootpFields,
    summaryKeys: ["op", "htype", "ciaddr", "yiaddr"],
  },
  dhcp: {
    id: "dhcp",
    responseKey: "dhcpRawEvents",
    hasPorts: true,
    fields: dhcpFields,
    summaryKeys: ["msgType", "ciaddr", "yiaddr", "leaseTime"],
  },
  radius: {
    id: "radius",
    responseKey: "radiusRawEvents",
    hasPorts: true,
    fields: radiusFields,
    summaryKeys: ["code", "respCode", "nasIp", "userName"],
  },
  icmp: {
    id: "icmp",
    responseKey: "icmpRawEvents",
    hasPorts: false,
    fields: icmpFields,
    summaryKeys: ["icmpType", "icmpCode", "id", "seqNum"],
  },
};

export const SUB_RECORD_FIELDS = {
  dceRpcContext: dceRpcContextFields,
  ftpCommand: ftpCommandFields,
  dhcpOption: dhcpOptionFields,
} as const;
