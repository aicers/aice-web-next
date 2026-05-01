"use client";

import { AlertTriangle, ArrowLeft, Info, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import type { Event } from "@/lib/detection/types";
import type { EventLocator } from "@/lib/events/event-locator";
import { cn } from "@/lib/utils";

import {
  EVENT_KIND_FRIENDLY_NAMES,
  formatEndpointSummary,
  levelBadgeVariant,
} from "./event-display-helpers";
import { ContextTab } from "./tabs/context-tab";
import { EndpointsTab } from "./tabs/endpoints-tab";
import { OverviewTab } from "./tabs/overview-tab";
import { hasPayloadData, PayloadTab } from "./tabs/payload-tab";
import { hasProtocolData, ProtocolTab } from "./tabs/protocol-tab";
import { RelatedTab } from "./tabs/related-tab";

export interface EventInvestigationLabels {
  back: string;
  severity: string;
  time: string;
  confidence: string;
  multipleNotice: string;
  tabs: {
    overview: string;
    endpoints: string;
    protocol: string;
    payload: string;
    context: string;
    related: string;
  };
  overview: {
    summary: string;
    time: string;
    kind: string;
    category: string;
    level: string;
    confidence: string;
    triageScores: string;
    noTriage: string;
    aimerTitle: string;
    aimerBody: string;
    aimerCta: string;
    aimerToast: string;
    pivotsTitle: string;
    pivotSameSource: string;
    pivotSameDestination: string;
    pivotSameKind: string;
  };
  endpoints: {
    source: string;
    destination: string;
    ip: string;
    country: string;
    region: string;
    city: string;
    coordinates: string;
    ports: string;
    company: string;
    companySourceCustomer: string;
    companySourceNetwork: string;
    companySourceIsp: string;
    noCompany: string;
    loading: string;
    map: {
      title: string;
      sourceLegend: string;
      destinationLegend: string;
    };
  };
  protocol: {
    noFields: string;
    http: {
      request: string;
      response: string;
      auth: string;
      body: string;
      fields: {
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
      };
    };
    dns: {
      query: string;
      response: string;
      flags: string;
      fields: {
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
      };
    };
    scan: {
      targets: string;
      duration: string;
      fields: {
        scannedPorts: string;
        startTime: string;
        endTime: string;
      };
    };
    ftp: {
      users: string;
      duration: string;
      fields: {
        userList: string;
        startTime: string;
        endTime: string;
      };
    };
    ftpPlainText: {
      auth: string;
      duration: string;
      session: string;
      fields: {
        user: string;
        password: string;
        startTime: string;
        duration: string;
        commands: string;
      };
    };
    multiHostScan: {
      targets: string;
      duration: string;
      fields: {
        respAddrs: string;
        respPort: string;
        startTime: string;
        endTime: string;
      };
    };
    network: {
      title: string;
      fields: {
        service: string;
        attackKind: string;
        content: string;
        startTime: string;
        duration: string;
      };
    };
    blocklist: {
      title: string;
      fields: {
        state: string;
        service: string;
        startTime: string;
        duration: string;
        origBytes: string;
        respBytes: string;
        origPkts: string;
        respPkts: string;
      };
    };
  };
  payload: {
    title: string;
    description: string;
    size: string;
    bytes: string;
    download: string;
    downloadName: string;
  };
  context: {
    threatName: string;
    threatCategory: string;
    threatLevel: string;
    explanation: string;
    mitre: string;
    tactic: string;
    technique: string;
    subTechnique: string;
    none: string;
  };
  related: {
    sameSource: string;
    sameDestination: string;
    sameKind: string;
    sameSession: string;
    lastDay: string;
    lastWeek: string;
    openInSearch: string;
    loading: string;
    count: string;
    lastSeen: string;
    none: string;
    note: string;
  };
}

interface Props {
  event: Event;
  locator: EventLocator;
  multipleMatches: boolean;
  backHref: string;
  labels: EventInvestigationLabels;
  /**
   * Customer IDs the operator was narrowed to on the originating
   * Detection page (#384). Threaded through to the Overview and
   * Related tabs so their outbound pivot URLs preserve the customer
   * narrowing rather than landing on the unfiltered set.
   */
  customers?: readonly string[];
}

export function EventInvestigation({
  event,
  locator,
  multipleMatches,
  backHref,
  labels,
  customers,
}: Props) {
  const friendlyKind =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const endpointSummary = formatEndpointSummary(event);
  const showPayload = hasPayloadData(event);
  const showProtocol = hasProtocolData(event);

  // Track which tabs the user has activated. Lazy-tab components
  // (EndpointsTab, RelatedTab) fetch their data on mount — but #291
  // requires those fetches to be cached for the life of the page.
  // Unmounting the content on tab switch would re-issue the fetch,
  // so we forceMount any tab once it has been activated and let
  // Radix keep it in the DOM (hidden) thereafter. The default tab
  // is pre-seeded so the initial render is indistinguishable from
  // the pre-caching behaviour.
  const [activated, setActivated] = useState<Set<string>>(
    () => new Set(["overview"]),
  );
  const markActivated = (value: string) => {
    setActivated((prev) => (prev.has(value) ? prev : new Set(prev).add(value)));
  };
  const forceMount = (value: string) =>
    activated.has(value) ? (true as const) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <Link
          href={backHref}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {labels.back}
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-foreground text-2xl font-semibold">
            {friendlyKind}
            {endpointSummary ? (
              <span className="text-muted-foreground ml-2 text-lg font-normal">
                · {endpointSummary}
              </span>
            ) : null}
          </h1>
          <Badge
            variant={levelBadgeVariant(event.level)}
            aria-label={labels.severity}
          >
            {event.level}
          </Badge>
        </div>

        <dl className="text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="flex items-center gap-1.5">
            <dt className="font-medium">{labels.time}</dt>
            <dd>
              <time dateTime={event.time}>{event.time}</time>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="font-medium">{labels.confidence}</dt>
            <dd>{event.confidence.toFixed(2)}</dd>
          </div>
        </dl>

        {multipleMatches ? (
          <div
            role="status"
            className="border-border text-foreground flex items-start gap-2 rounded-md border bg-amber-500/10 px-3 py-2 text-sm"
          >
            <AlertTriangle
              className="mt-0.5 size-4 text-amber-500"
              aria-hidden="true"
            />
            <span>{labels.multipleNotice}</span>
          </div>
        ) : null}
      </header>

      <Tabs
        defaultValue="overview"
        className="w-full"
        onValueChange={markActivated}
      >
        <TabsList>
          <TabsTrigger value="overview">{labels.tabs.overview}</TabsTrigger>
          <TabsTrigger value="endpoints">{labels.tabs.endpoints}</TabsTrigger>
          {showProtocol ? (
            <TabsTrigger value="protocol">{labels.tabs.protocol}</TabsTrigger>
          ) : null}
          {showPayload ? (
            <TabsTrigger value="payload">{labels.tabs.payload}</TabsTrigger>
          ) : null}
          <TabsTrigger value="context">{labels.tabs.context}</TabsTrigger>
          <TabsTrigger value="related">{labels.tabs.related}</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          className="pt-4"
          forceMount={forceMount("overview")}
        >
          <OverviewTab
            event={event}
            locator={locator}
            labels={labels.overview}
            customers={customers}
          />
        </TabsContent>
        <TabsContent
          value="endpoints"
          className="pt-4"
          forceMount={forceMount("endpoints")}
        >
          <EndpointsTab
            event={event}
            locator={locator}
            labels={labels.endpoints}
          />
        </TabsContent>
        {showProtocol ? (
          <TabsContent
            value="protocol"
            className="pt-4"
            forceMount={forceMount("protocol")}
          >
            <ProtocolTab event={event} labels={labels.protocol} />
          </TabsContent>
        ) : null}
        {showPayload ? (
          <TabsContent
            value="payload"
            className="pt-4"
            forceMount={forceMount("payload")}
          >
            <PayloadTab event={event} labels={labels.payload} />
          </TabsContent>
        ) : null}
        <TabsContent
          value="context"
          className="pt-4"
          forceMount={forceMount("context")}
        >
          <ContextTab event={event} labels={labels.context} />
        </TabsContent>
        <TabsContent
          value="related"
          className="pt-4"
          forceMount={forceMount("related")}
        >
          <RelatedTab
            locator={locator}
            labels={labels.related}
            customers={customers}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const AIMER_TOAST_DURATION_MS = 3200;

/**
 * "Send to Aimer" placeholder. The button pops a transient floating
 * toast in the viewport's lower-right corner so the placeholder
 * interaction matches the issue spec; the umbrella ships no toast
 * primitive, so this component owns a minimal self-dismissing one.
 */
export function AimerBanner({
  label,
  body,
  cta,
  toast,
}: {
  label: string;
  body: string;
  cta: string;
  toast: string;
}) {
  const [toastId, setToastId] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (toastId === 0) {
      return;
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setToastId(0);
      timerRef.current = null;
    }, AIMER_TOAST_DURATION_MS);
  }, [toastId]);

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 text-blue-500" aria-hidden="true" />
        <div className="flex-1">
          <h3 className="text-foreground text-sm font-semibold">{label}</h3>
          <p className="text-muted-foreground mt-1 text-sm">{body}</p>
        </div>
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setToastId((id) => id + 1)}
        >
          <Send className="size-4" aria-hidden="true" />
          {cta}
        </Button>
      </div>
      <AimerToast key={toastId} visible={toastId !== 0} message={toast} />
    </div>
  );
}

function AimerToast({
  visible,
  message,
}: {
  visible: boolean;
  message: string;
}) {
  if (!visible) {
    return null;
  }
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex justify-end"
      data-testid="aimer-toast"
    >
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "border-border bg-popover text-popover-foreground pointer-events-auto flex items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-md",
        )}
      >
        <Info className="size-4 text-blue-500" aria-hidden="true" />
        <span>{message}</span>
      </div>
    </div>
  );
}
