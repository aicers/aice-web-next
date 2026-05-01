import { getTranslations } from "next-intl/server";
import { EventInvestigation } from "@/components/events/event-investigation";
import { EventNotFound } from "@/components/events/event-not-found";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import { fetchEventByLocator } from "@/lib/detection";
import type { Event } from "@/lib/detection/types";
import { decodeEventLocator } from "@/lib/events/event-locator";
import { sanitizeReturnTo } from "@/lib/events/return-to";

interface PageProps {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EventInvestigationPage({
  params,
  searchParams,
}: PageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "detection:read");

  const { token } = await params;
  const resolvedSearch = await searchParams;
  const backHref = sanitizeReturnTo(resolvedSearch.returnTo);
  // Forward the active Detection customer narrowing (#384) onto the
  // outbound pivot URLs the Overview / Related tabs render. The
  // value lives in a separate URL param rather than being decoded
  // out of `returnTo` so this route does not have to know the
  // encoded `?f=` filter shape.
  const investigationCustomers = parseCustomersParam(resolvedSearch.customers);
  const t = await getTranslations("events");

  const locator = decodeEventLocator(token);
  if (!locator) {
    return (
      <EventNotFound
        reason="invalid-token"
        backHref={backHref}
        labels={buildLabels(t)}
      />
    );
  }

  let resolution: Awaited<ReturnType<typeof fetchEventByLocator>>;
  try {
    resolution = await fetchEventByLocator(session, locator);
  } catch {
    return (
      <EventNotFound
        reason="fetch-error"
        backHref={backHref}
        labels={buildLabels(t)}
      />
    );
  }

  if (resolution.status === "zero") {
    return (
      <EventNotFound
        reason="not-found"
        backHref={backHref}
        labels={buildLabels(t)}
      />
    );
  }

  const event: Event = resolution.event;

  return (
    <EventInvestigation
      event={event}
      locator={locator}
      multipleMatches={resolution.status === "multiple"}
      backHref={backHref}
      labels={buildInvestigationLabels(t)}
      customers={investigationCustomers}
    />
  );
}

/**
 * Parse the `customers` query param into a `string[]` of positive
 * integer IDs. Matches the wire format `EventListFilterInput.customers`
 * so the parsed value plugs straight into the pivot URL builder. Any
 * entry that does not parse as a positive integer is dropped — the
 * Detection BFF intersection check (#384) is the authoritative gate,
 * so a tampered URL that survives this filter is still rejected on
 * dispatch.
 */
function parseCustomersParam(
  raw: string | string[] | undefined,
): readonly string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

type EventsTranslator = Awaited<ReturnType<typeof getTranslations>>;

function buildLabels(t: EventsTranslator) {
  return {
    invalidTokenTitle: t("notFound.invalidTokenTitle"),
    invalidTokenBody: t("notFound.invalidTokenBody"),
    notFoundTitle: t("notFound.notFoundTitle"),
    notFoundBody: t("notFound.notFoundBody"),
    fetchErrorTitle: t("notFound.fetchErrorTitle"),
    fetchErrorBody: t("notFound.fetchErrorBody"),
    back: t("notFound.back"),
  };
}

function buildInvestigationLabels(t: EventsTranslator) {
  return {
    back: t("header.back"),
    severity: t("header.severity"),
    time: t("header.time"),
    confidence: t("header.confidence"),
    multipleNotice: t("header.multipleNotice"),
    tabs: {
      overview: t("tabs.overview"),
      endpoints: t("tabs.endpoints"),
      protocol: t("tabs.protocol"),
      payload: t("tabs.payload"),
      context: t("tabs.context"),
      related: t("tabs.related"),
    },
    overview: {
      summary: t("overview.summary"),
      time: t("overview.time"),
      kind: t("overview.kind"),
      category: t("overview.category"),
      level: t("overview.level"),
      confidence: t("overview.confidence"),
      triageScores: t("overview.triageScores"),
      noTriage: t("overview.noTriage"),
      aimerTitle: t("overview.aimerTitle"),
      aimerBody: t("overview.aimerBody"),
      aimerCta: t("overview.aimerCta"),
      aimerToast: t("overview.aimerToast"),
      pivotsTitle: t("overview.pivotsTitle"),
      pivotSameSource: t("overview.pivotSameSource"),
      pivotSameDestination: t("overview.pivotSameDestination"),
      pivotSameKind: t("overview.pivotSameKind"),
    },
    endpoints: {
      source: t("endpoints.source"),
      destination: t("endpoints.destination"),
      ip: t("endpoints.ip"),
      country: t("endpoints.country"),
      region: t("endpoints.region"),
      city: t("endpoints.city"),
      coordinates: t("endpoints.coordinates"),
      ports: t("endpoints.ports"),
      company: t("endpoints.company"),
      companySourceCustomer: t("endpoints.companySourceCustomer"),
      companySourceNetwork: t("endpoints.companySourceNetwork"),
      companySourceIsp: t("endpoints.companySourceIsp"),
      noCompany: t("endpoints.noCompany"),
      loading: t("endpoints.loading"),
      map: {
        title: t("endpoints.map.title"),
        sourceLegend: t("endpoints.map.sourceLegend"),
        destinationLegend: t("endpoints.map.destinationLegend"),
      },
    },
    protocol: {
      noFields: t("protocol.noFields"),
      http: {
        request: t("protocol.http.request"),
        response: t("protocol.http.response"),
        auth: t("protocol.http.auth"),
        body: t("protocol.http.body"),
        fields: {
          method: t("protocol.http.fields.method"),
          host: t("protocol.http.fields.host"),
          uri: t("protocol.http.fields.uri"),
          referer: t("protocol.http.fields.referer"),
          version: t("protocol.http.fields.version"),
          userAgent: t("protocol.http.fields.userAgent"),
          requestLen: t("protocol.http.fields.requestLen"),
          statusCode: t("protocol.http.fields.statusCode"),
          statusMsg: t("protocol.http.fields.statusMsg"),
          responseLen: t("protocol.http.fields.responseLen"),
          contentEncoding: t("protocol.http.fields.contentEncoding"),
          contentType: t("protocol.http.fields.contentType"),
          cacheControl: t("protocol.http.fields.cacheControl"),
          username: t("protocol.http.fields.username"),
          password: t("protocol.http.fields.password"),
          cookie: t("protocol.http.fields.cookie"),
          filenames: t("protocol.http.fields.filenames"),
          mimeTypes: t("protocol.http.fields.mimeTypes"),
          content: t("protocol.http.fields.content"),
          body: t("protocol.http.fields.body"),
        },
      },
      dns: {
        query: t("protocol.dns.query"),
        response: t("protocol.dns.response"),
        flags: t("protocol.dns.flags"),
        fields: {
          query: t("protocol.dns.fields.query"),
          queryClass: t("protocol.dns.fields.queryClass"),
          queryType: t("protocol.dns.fields.queryType"),
          transactionId: t("protocol.dns.fields.transactionId"),
          roundTripTime: t("protocol.dns.fields.roundTripTime"),
          answer: t("protocol.dns.fields.answer"),
          responseCode: t("protocol.dns.fields.responseCode"),
          ttl: t("protocol.dns.fields.ttl"),
          authoritative: t("protocol.dns.fields.authoritative"),
          truncated: t("protocol.dns.fields.truncated"),
          recursionDesired: t("protocol.dns.fields.recursionDesired"),
          recursionAvailable: t("protocol.dns.fields.recursionAvailable"),
        },
      },
      scan: {
        targets: t("protocol.scan.targets"),
        duration: t("protocol.scan.duration"),
        fields: {
          scannedPorts: t("protocol.scan.fields.scannedPorts"),
          startTime: t("protocol.scan.fields.startTime"),
          endTime: t("protocol.scan.fields.endTime"),
        },
      },
      ftp: {
        users: t("protocol.ftp.users"),
        duration: t("protocol.ftp.duration"),
        fields: {
          userList: t("protocol.ftp.fields.userList"),
          startTime: t("protocol.ftp.fields.startTime"),
          endTime: t("protocol.ftp.fields.endTime"),
        },
      },
      ftpPlainText: {
        auth: t("protocol.ftpPlainText.auth"),
        duration: t("protocol.ftpPlainText.duration"),
        session: t("protocol.ftpPlainText.session"),
        fields: {
          user: t("protocol.ftpPlainText.fields.user"),
          password: t("protocol.ftpPlainText.fields.password"),
          startTime: t("protocol.ftpPlainText.fields.startTime"),
          duration: t("protocol.ftpPlainText.fields.duration"),
          commands: t("protocol.ftpPlainText.fields.commands"),
        },
      },
      multiHostScan: {
        targets: t("protocol.multiHostScan.targets"),
        duration: t("protocol.multiHostScan.duration"),
        fields: {
          respAddrs: t("protocol.multiHostScan.fields.respAddrs"),
          respPort: t("protocol.multiHostScan.fields.respPort"),
          startTime: t("protocol.multiHostScan.fields.startTime"),
          endTime: t("protocol.multiHostScan.fields.endTime"),
        },
      },
      network: {
        title: t("protocol.network.title"),
        fields: {
          service: t("protocol.network.fields.service"),
          attackKind: t("protocol.network.fields.attackKind"),
          content: t("protocol.network.fields.content"),
          startTime: t("protocol.network.fields.startTime"),
          duration: t("protocol.network.fields.duration"),
        },
      },
      blocklist: {
        title: t("protocol.blocklist.title"),
        fields: {
          state: t("protocol.blocklist.fields.state"),
          service: t("protocol.blocklist.fields.service"),
          startTime: t("protocol.blocklist.fields.startTime"),
          duration: t("protocol.blocklist.fields.duration"),
          origBytes: t("protocol.blocklist.fields.origBytes"),
          respBytes: t("protocol.blocklist.fields.respBytes"),
          origPkts: t("protocol.blocklist.fields.origPkts"),
          respPkts: t("protocol.blocklist.fields.respPkts"),
        },
      },
    },
    payload: {
      title: t("payload.title"),
      description: t("payload.description"),
      size: t("payload.size"),
      bytes: t("payload.bytes"),
      download: t("payload.download"),
      downloadName: t("payload.downloadName"),
    },
    context: {
      threatName: t("context.threatName"),
      threatCategory: t("context.threatCategory"),
      threatLevel: t("context.threatLevel"),
      explanation: t("context.explanation"),
      mitre: t("context.mitre"),
      tactic: t("context.tactic"),
      technique: t("context.technique"),
      subTechnique: t("context.subTechnique"),
      none: t("context.none"),
    },
    related: {
      sameSource: t("related.sameSource"),
      sameDestination: t("related.sameDestination"),
      sameKind: t("related.sameKind"),
      sameSession: t("related.sameSession"),
      lastDay: t("related.lastDay"),
      lastWeek: t("related.lastWeek"),
      openInSearch: t("related.openInSearch"),
      loading: t("related.loading"),
      count: t("related.count"),
      lastSeen: t("related.lastSeen"),
      none: t("related.none"),
      note: t("related.note"),
    },
  } as const;
}
