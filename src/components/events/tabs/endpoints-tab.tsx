"use client";

import { useEffect, useMemo, useState } from "react";

import type { Event, IpLocationResult } from "@/lib/detection/types";
import { fetchEndpointEnrichments } from "@/lib/events/endpoint-enrichment";
import type { EndpointEnrichmentMap } from "@/lib/events/endpoint-enrichment-types";
import type { EventLocator } from "@/lib/events/event-locator";

export interface EndpointsLabels {
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
}

export type EndpointEnrichment = IpLocationResult["ipLocation"];

interface Props {
  event: Event;
  locator: EventLocator;
  labels: EndpointsLabels;
}

type CustomerLike = { id: string; name: string } | null | undefined;
type NetworkLike = { id: string; name: string } | null | undefined;

interface EndpointShape {
  addr?: string;
  country?: string;
  ports?: number | number[];
  customer?: CustomerLike;
  network?: NetworkLike;
}

/**
 * Endpoints tab — per the issue spec, non-Overview tabs fetch
 * their own data lazily on first activation. This component is
 * mounted only when the user opens the Endpoints tab (Radix
 * unmounts `TabsContent` by default), so `ipLocation` lookups
 * do not run for users who never open the tab.
 */
export function EndpointsTab({ event, locator, labels }: Props) {
  // `event` and `locator` are stable for the life of the page;
  // memoizing on them keeps the fetch effect and the endpoint
  // render lists from re-running on unrelated re-renders.
  const sources = useMemo(() => buildSources(event, locator), [event, locator]);
  const destinations = useMemo(
    () => buildDestinations(event, locator),
    [event, locator],
  );
  const addresses = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...sources.map((s) => s.addr),
            ...destinations.map((d) => d.addr),
          ].filter(
            (addr): addr is string =>
              typeof addr === "string" && addr.length > 0,
          ),
        ),
      ),
    [sources, destinations],
  );
  const [enrichments, setEnrichments] = useState<EndpointEnrichmentMap | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    fetchEndpointEnrichments(addresses)
      .then((result) => {
        if (!cancelled) setEnrichments(result);
      })
      .catch(() => {
        if (!cancelled) setEnrichments({});
      });
    return () => {
      cancelled = true;
    };
  }, [addresses]);

  const loading = enrichments === null;

  return (
    <div className="flex flex-col gap-3">
      {loading ? (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-xs"
        >
          {labels.loading}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          {sources.map((origin, index) => {
            const enrichment =
              !loading && origin.addr ? enrichments[origin.addr] : undefined;
            const title =
              sources.length > 1
                ? `${labels.source} ${index + 1}`
                : labels.source;
            const key = origin.addr
              ? `${origin.addr}#${index}`
              : `src#${index}`;
            return (
              <EndpointCard
                key={key}
                title={title}
                endpoint={origin}
                enrichment={enrichment}
                labels={labels}
              />
            );
          })}
        </div>
        <div className="flex flex-col gap-3">
          {destinations.map((destination, index) => {
            const enrichment =
              !loading && destination.addr
                ? enrichments[destination.addr]
                : undefined;
            const title =
              destinations.length > 1
                ? `${labels.destination} ${index + 1}`
                : labels.destination;
            // Responder-array subtypes may legitimately repeat
            // the same address with different ports/customers, so
            // `addr` alone is not a stable key — combine with the
            // parallel index in the responder arrays.
            const key = destination.addr
              ? `${destination.addr}#${index}`
              : `dest#${index}`;
            return (
              <EndpointCard
                key={key}
                title={title}
                endpoint={destination}
                enrichment={enrichment}
                labels={labels}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EndpointCard({
  title,
  endpoint,
  enrichment,
  labels,
}: {
  title: string;
  endpoint: EndpointShape;
  enrichment: EndpointEnrichment | undefined;
  labels: EndpointsLabels;
}) {
  const portsLabel =
    endpoint.ports === undefined
      ? "—"
      : Array.isArray(endpoint.ports)
        ? endpoint.ports.join(", ") || "—"
        : String(endpoint.ports);
  const countryLabel = buildCountryLabel(endpoint.country, enrichment?.country);
  const coords = formatCoordinates(enrichment);

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{labels.ip}</dt>
        <dd className="text-foreground font-mono">{endpoint.addr ?? "—"}</dd>

        <dt className="text-muted-foreground">{labels.country}</dt>
        <dd className="text-foreground">{countryLabel}</dd>

        {enrichment?.region ? (
          <>
            <dt className="text-muted-foreground">{labels.region}</dt>
            <dd className="text-foreground">{enrichment.region}</dd>
          </>
        ) : null}

        {enrichment?.city ? (
          <>
            <dt className="text-muted-foreground">{labels.city}</dt>
            <dd className="text-foreground">{enrichment.city}</dd>
          </>
        ) : null}

        {coords ? (
          <>
            <dt className="text-muted-foreground">{labels.coordinates}</dt>
            <dd className="text-foreground font-mono">{coords}</dd>
          </>
        ) : null}

        <dt className="text-muted-foreground">{labels.ports}</dt>
        <dd className="text-foreground font-mono">{portsLabel}</dd>

        <dt className="text-muted-foreground">{labels.company}</dt>
        <dd className="text-foreground">
          {renderCompany(endpoint, enrichment, labels)}
        </dd>
      </dl>
    </section>
  );
}

function renderCompany(
  endpoint: EndpointShape,
  enrichment: EndpointEnrichment | undefined,
  labels: EndpointsLabels,
) {
  const derived = deriveCompany(endpoint, enrichment);
  if (!derived) {
    return <span className="text-muted-foreground">{labels.noCompany}</span>;
  }
  const sourceLabel =
    derived.source === "customer"
      ? labels.companySourceCustomer
      : derived.source === "network"
        ? labels.companySourceNetwork
        : labels.companySourceIsp;
  return (
    <span>
      {derived.name}{" "}
      <span className="text-muted-foreground text-xs">({sourceLabel})</span>
    </span>
  );
}

function deriveCompany(
  endpoint: EndpointShape,
  enrichment: EndpointEnrichment | undefined,
): { name: string; source: "customer" | "network" | "isp" } | null {
  if (endpoint.customer?.name) {
    return { name: endpoint.customer.name, source: "customer" };
  }
  if (endpoint.network?.name) {
    return { name: endpoint.network.name, source: "network" };
  }
  if (enrichment?.isp) {
    return { name: enrichment.isp, source: "isp" };
  }
  return null;
}

function buildCountryLabel(
  code: string | undefined,
  fullName: string | null | undefined,
): string {
  const usableCode = code && code !== "XX" && code !== "ZZ" ? code : null;
  if (usableCode && fullName) return `${usableCode} · ${fullName}`;
  if (usableCode) return usableCode;
  if (fullName) return fullName;
  return "—";
}

function formatCoordinates(
  enrichment: EndpointEnrichment | undefined,
): string | null {
  if (!enrichment) return null;
  const { latitude, longitude } = enrichment;
  if (latitude === null || longitude === null) return null;
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function buildSources(event: Event, locator: EventLocator): EndpointShape[] {
  const e = event as Partial<{
    origAddr: string;
    origAddrs: string[];
    origCountry: string;
    origCountries: string[];
    origPort: number;
    origCustomer: CustomerLike;
    origCustomers: CustomerLike[];
    origNetwork: NetworkLike;
  }>;

  // Array-originator subtypes (e.g. ExternalDdos) expose
  // `origAddrs`/`origCountries`/`origCustomers` in parallel. The
  // deep-view spec is "show all rows for array endpoints", so we
  // emit one card per originator with its own country / customer
  // when available.
  if (Array.isArray(e.origAddrs) && e.origAddrs.length > 0) {
    return e.origAddrs.map((addr, index) => ({
      addr,
      country: e.origCountries?.[index],
      ports: e.origPort,
      customer: e.origCustomers?.[index],
      network: e.origNetwork,
    }));
  }

  // Singular originator fallback. When an event arrives from the list
  // query without the detail selection (rare, but possible for
  // subtypes outside the inline-fragment set), fall back to the
  // locator's `origAddr` so the card still renders an address.
  return [
    {
      addr: e.origAddr ?? locator.origAddr,
      country: e.origCountry,
      ports: e.origPort,
      customer: e.origCustomer,
      network: e.origNetwork,
    },
  ];
}

function buildDestinations(
  event: Event,
  locator: EventLocator,
): EndpointShape[] {
  const e = event as Partial<{
    respAddr: string;
    respAddrs: string[];
    respCountry: string;
    respCountries: string[];
    respPort: number;
    respPorts: number[];
    respCustomer: CustomerLike;
    respCustomers: CustomerLike[];
    respNetwork: NetworkLike;
  }>;

  // Array-responder subtypes (e.g. MultiHostPortScan) expose
  // `respAddrs`/`respCountries`/`respCustomers` in parallel. The
  // deep-view spec is "show all rows for array endpoints", so we
  // emit one card per destination with its own country / customer
  // when available.
  if (Array.isArray(e.respAddrs) && e.respAddrs.length > 0) {
    return e.respAddrs.map((addr, index) => ({
      addr,
      country: e.respCountries?.[index],
      ports: e.respPort,
      customer: e.respCustomers?.[index],
      network: e.respNetwork,
    }));
  }

  // Singular responder fallback. When an event arrives from the list
  // query without the detail selection (rare, but possible for
  // subtypes outside the inline-fragment set), fall back to the
  // locator's `respAddr` so the card still renders an address.
  return [
    {
      addr: e.respAddr ?? locator.respAddr,
      country: e.respCountry,
      ports: e.respPorts ?? e.respPort,
      customer: e.respCustomer,
      network: e.respNetwork,
    },
  ];
}
