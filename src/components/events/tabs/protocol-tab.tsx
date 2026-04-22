import type { Event } from "@/lib/detection/types";

interface HttpFieldLabels {
  method: string;
  host: string;
  uri: string;
  referer: string;
  version: string;
  userAgent: string;
  requestLen: string;
  statusCode: string;
  statusMsg: string;
  responseLen: string;
  contentEncoding: string;
  contentType: string;
  cacheControl: string;
  username: string;
  password: string;
  cookie: string;
  filenames: string;
  mimeTypes: string;
  content: string;
  body: string;
}

interface DnsFieldLabels {
  query: string;
  queryClass: string;
  queryType: string;
  transactionId: string;
  roundTripTime: string;
  answer: string;
  responseCode: string;
  ttl: string;
  authoritative: string;
  truncated: string;
  recursionDesired: string;
  recursionAvailable: string;
}

interface ScanFieldLabels {
  scannedPorts: string;
  startTime: string;
  endTime: string;
}

interface FtpFieldLabels {
  userList: string;
  startTime: string;
  endTime: string;
}

interface NetworkFieldLabels {
  service: string;
  attackKind: string;
  content: string;
  startTime: string;
  duration: string;
}

interface BlocklistFieldLabels {
  state: string;
  service: string;
  startTime: string;
  duration: string;
  origBytes: string;
  respBytes: string;
  origPkts: string;
  respPkts: string;
}

interface FtpPlainTextFieldLabels {
  user: string;
  password: string;
  startTime: string;
  duration: string;
  commands: string;
}

interface MultiHostScanFieldLabels {
  respAddrs: string;
  respPort: string;
  startTime: string;
  endTime: string;
}

export interface ProtocolLabels {
  noFields: string;
  http: {
    request: string;
    response: string;
    auth: string;
    body: string;
    fields: HttpFieldLabels;
  };
  dns: {
    query: string;
    response: string;
    flags: string;
    fields: DnsFieldLabels;
  };
  scan: {
    targets: string;
    duration: string;
    fields: ScanFieldLabels;
  };
  ftp: {
    users: string;
    duration: string;
    fields: FtpFieldLabels;
  };
  ftpPlainText: {
    auth: string;
    duration: string;
    session: string;
    fields: FtpPlainTextFieldLabels;
  };
  multiHostScan: {
    targets: string;
    duration: string;
    fields: MultiHostScanFieldLabels;
  };
  network: {
    title: string;
    fields: NetworkFieldLabels;
  };
  blocklist: {
    title: string;
    fields: BlocklistFieldLabels;
  };
}

interface Props {
  event: Event;
  labels: ProtocolLabels;
}

/**
 * Logical per-subtype grouping. Adding a new `Event` subtype with
 * kind-specific fields means adding a branch here *and* listing
 * its `__typename` in `PROTOCOL_SUPPORTED_TYPENAMES` so the parent
 * tab handler knows there is kind-specific content to show.
 */
export function ProtocolTab({ event, labels }: Props) {
  switch (event.__typename) {
    case "HttpThreat":
      return <HttpGroups event={event} labels={labels.http} />;
    case "DnsCovertChannel":
    case "BlocklistDns":
      return <DnsGroups event={event} labels={labels.dns} />;
    case "PortScan":
      return <PortScanGroups event={event} labels={labels.scan} />;
    case "MultiHostPortScan":
      return (
        <MultiHostPortScanGroups event={event} labels={labels.multiHostScan} />
      );
    case "FtpBruteForce":
      return <FtpGroups event={event} labels={labels.ftp} />;
    case "FtpPlainText":
      return <FtpPlainTextGroups event={event} labels={labels.ftpPlainText} />;
    case "NetworkThreat":
      return <NetworkThreatGroups event={event} labels={labels.network} />;
    case "BlocklistConn":
      return <BlocklistConnGroups event={event} labels={labels.blocklist} />;
    default:
      return <p className="text-muted-foreground text-sm">{labels.noFields}</p>;
  }
}

/**
 * Set of `__typename`s that ProtocolTab knows how to render. The
 * investigation page hides the Protocol tab entirely for events
 * whose subtype is not in this set ("tabs that have no data are
 * hidden" per #291).
 */
const PROTOCOL_SUPPORTED_TYPENAMES = new Set<string>([
  "BlocklistConn",
  "BlocklistDns",
  "DnsCovertChannel",
  "FtpBruteForce",
  "FtpPlainText",
  "HttpThreat",
  "MultiHostPortScan",
  "NetworkThreat",
  "PortScan",
]);

export function hasProtocolData(event: Event): boolean {
  return PROTOCOL_SUPPORTED_TYPENAMES.has(event.__typename);
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card flex flex-col gap-2 rounded-md border p-4">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {children}
      </dl>
    </section>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }
  const rendered = Array.isArray(value) ? value.join(", ") : String(value);
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground break-all font-mono">{rendered}</dd>
    </>
  );
}

function HttpGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["http"];
}) {
  const e = event as Partial<{
    method: string;
    host: string;
    uri: string;
    referer: string;
    version: string;
    userAgent: string;
    requestLen: string;
    responseLen: string;
    statusCode: number;
    statusMsg: string;
    contentEncoding: string;
    contentType: string;
    cacheControl: string;
    username: string;
    password: string;
    cookie: string;
    filenames: string[];
    mimeTypes: string[];
    body: number[];
    content: string;
  }>;
  const f = labels.fields;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.request}>
        <Field label={f.method} value={e.method} />
        <Field label={f.host} value={e.host} />
        <Field label={f.uri} value={e.uri} />
        <Field label={f.referer} value={e.referer} />
        <Field label={f.version} value={e.version} />
        <Field label={f.userAgent} value={e.userAgent} />
        <Field label={f.requestLen} value={e.requestLen} />
      </Section>
      <Section title={labels.response}>
        <Field label={f.statusCode} value={e.statusCode} />
        <Field label={f.statusMsg} value={e.statusMsg} />
        <Field label={f.responseLen} value={e.responseLen} />
        <Field label={f.contentEncoding} value={e.contentEncoding} />
        <Field label={f.contentType} value={e.contentType} />
        <Field label={f.cacheControl} value={e.cacheControl} />
      </Section>
      <Section title={labels.auth}>
        <Field label={f.username} value={e.username} />
        <Field label={f.password} value={maskSecret(e.password)} />
        <Field label={f.cookie} value={e.cookie} />
      </Section>
      <Section title={labels.body}>
        <Field label={f.filenames} value={e.filenames} />
        <Field label={f.mimeTypes} value={e.mimeTypes} />
        <Field label={f.content} value={e.content} />
        <Field label={f.body} value={previewByteArray(e.body)} />
      </Section>
    </div>
  );
}

/**
 * Render passwords as a fixed-length mask. The full plaintext is
 * still in REview (and in the GraphQL response), but the
 * Investigation page intentionally never paints it.
 */
function maskSecret(value: string | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;
  return "•".repeat(Math.min(value.length, 12));
}

/**
 * Compact preview for `HttpThreat.body` (`[Int!]!` byte stream).
 * We show length + first 64 bytes hex so investigators can spot
 * obvious markers without the page bloating into a full hex dump
 * (the dedicated Payload tab covers that path).
 */
function previewByteArray(bytes: number[] | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  const head = bytes
    .slice(0, 64)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const suffix = bytes.length > 64 ? " …" : "";
  return `${bytes.length} B · ${head}${suffix}`;
}

function DnsGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["dns"];
}) {
  const e = event as Partial<{
    query: string;
    answer: string[];
    transId: number;
    rtt: string;
    qclass: number;
    qtype: number;
    rcode: number;
    aaFlag: boolean;
    tcFlag: boolean;
    rdFlag: boolean;
    raFlag: boolean;
    ttl: number[];
  }>;
  const f = labels.fields;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.query}>
        <Field label={f.query} value={e.query} />
        <Field label={f.queryClass} value={e.qclass} />
        <Field label={f.queryType} value={e.qtype} />
        <Field label={f.transactionId} value={e.transId} />
        <Field label={f.roundTripTime} value={e.rtt} />
      </Section>
      <Section title={labels.response}>
        <Field label={f.answer} value={e.answer} />
        <Field label={f.responseCode} value={e.rcode} />
        <Field label={f.ttl} value={e.ttl} />
      </Section>
      <Section title={labels.flags}>
        <Field label={f.authoritative} value={e.aaFlag} />
        <Field label={f.truncated} value={e.tcFlag} />
        <Field label={f.recursionDesired} value={e.rdFlag} />
        <Field label={f.recursionAvailable} value={e.raFlag} />
      </Section>
    </div>
  );
}

function PortScanGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["scan"];
}) {
  const e = event as Partial<{
    respPorts: number[];
    startTime: string;
    endTime: string;
  }>;
  const f = labels.fields;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.targets}>
        <Field label={f.scannedPorts} value={e.respPorts} />
      </Section>
      <Section title={labels.duration}>
        <Field label={f.startTime} value={e.startTime} />
        <Field label={f.endTime} value={e.endTime} />
      </Section>
    </div>
  );
}

function FtpGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["ftp"];
}) {
  const e = event as Partial<{
    userList: string[];
    startTime: string;
    endTime: string;
  }>;
  const f = labels.fields;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.users}>
        <Field label={f.userList} value={e.userList} />
      </Section>
      <Section title={labels.duration}>
        <Field label={f.startTime} value={e.startTime} />
        <Field label={f.endTime} value={e.endTime} />
      </Section>
    </div>
  );
}

function FtpPlainTextGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["ftpPlainText"];
}) {
  const e = event as Partial<{
    user: string;
    password: string;
    startTime: string;
    duration: string;
    commands: Array<{
      command: string;
      replyCode: string;
      replyMsg: string;
    }>;
  }>;
  const f = labels.fields;
  const commandsPreview = Array.isArray(e.commands)
    ? e.commands
        .slice(0, 10)
        .map((c) => (c.replyCode ? `${c.command} → ${c.replyCode}` : c.command))
    : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.auth}>
        <Field label={f.user} value={e.user} />
        <Field label={f.password} value={maskSecret(e.password)} />
      </Section>
      <Section title={labels.duration}>
        <Field label={f.startTime} value={e.startTime} />
        <Field label={f.duration} value={e.duration} />
      </Section>
      {commandsPreview && commandsPreview.length > 0 ? (
        <Section title={labels.session}>
          <Field label={f.commands} value={commandsPreview} />
        </Section>
      ) : null}
    </div>
  );
}

function MultiHostPortScanGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["multiHostScan"];
}) {
  const e = event as Partial<{
    respAddrs: string[];
    respPort: number;
    startTime: string;
    endTime: string;
  }>;
  const f = labels.fields;
  return (
    <div className="flex flex-col gap-4">
      <Section title={labels.targets}>
        <Field label={f.respAddrs} value={e.respAddrs} />
        <Field label={f.respPort} value={e.respPort} />
      </Section>
      <Section title={labels.duration}>
        <Field label={f.startTime} value={e.startTime} />
        <Field label={f.endTime} value={e.endTime} />
      </Section>
    </div>
  );
}

function NetworkThreatGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["network"];
}) {
  const e = event as Partial<{
    service: string;
    content: string;
    attackKind: string;
    startTime: string;
    duration: string;
  }>;
  const f = labels.fields;
  return (
    <Section title={labels.title}>
      <Field label={f.service} value={e.service} />
      <Field label={f.attackKind} value={e.attackKind} />
      <Field label={f.content} value={e.content} />
      <Field label={f.startTime} value={e.startTime} />
      <Field label={f.duration} value={e.duration} />
    </Section>
  );
}

function BlocklistConnGroups({
  event,
  labels,
}: {
  event: Event;
  labels: ProtocolLabels["blocklist"];
}) {
  const e = event as Partial<{
    connState: string;
    service: string;
    startTime: string;
    duration: string;
    origBytes: string;
    respBytes: string;
    origPkts: string;
    respPkts: string;
  }>;
  const f = labels.fields;
  return (
    <Section title={labels.title}>
      <Field label={f.state} value={e.connState} />
      <Field label={f.service} value={e.service} />
      <Field label={f.startTime} value={e.startTime} />
      <Field label={f.duration} value={e.duration} />
      <Field label={f.origBytes} value={e.origBytes} />
      <Field label={f.respBytes} value={e.respBytes} />
      <Field label={f.origPkts} value={e.origPkts} />
      <Field label={f.respPkts} value={e.respPkts} />
    </Section>
  );
}
