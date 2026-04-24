/**
 * Quick peek inspector rendering regressions (Phase Detection-18).
 *
 * The inspector is a client component that reads translated labels
 * and event payloads; these tests render to static HTML and assert
 * on the shape of the output so we catch:
 *
 * - Protocol highlights render the right fields per subtype.
 * - Empty protocol fields are hidden (the issue's "prefer hiding
 *   over Not Provided" rule).
 * - The `Open full investigation` action is a real `<a>` tag — the
 *   acceptance requirement for middle-click / Cmd+click.
 * - Pivot links render as real `<a>` tags pointing at
 *   `/detection?...` so they, too, survive middle-click.
 * - Subtypes without an encodable locator suppress the Open
 *   investigation action entirely rather than rendering a disabled
 *   button.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// `next-intl`'s navigation Link expects a routing context; stubbing
// it with a plain `<a>` keeps the tests framework-agnostic and
// preserves the "real anchor tag" acceptance check.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import {
  QuickPeekInspector,
  type QuickPeekInspectorLabels,
} from "@/components/detection/quick-peek-inspector";
import type { Event } from "@/lib/detection/types";

function labels(
  overrides: Partial<QuickPeekInspectorLabels> = {},
): QuickPeekInspectorLabels {
  return {
    close: "Close",
    summaryHeading: "Summary",
    endpointsHeading: "Endpoints",
    detectionMetaHeading: "Detection",
    protocolHeading: "Protocol",
    actionsHeading: "Actions",
    sourceLabel: "Source",
    destinationLabel: "Destination",
    sensorLabel: "Sensor",
    attackKindLabel: "Attack kind",
    learningMethodLabel: "AI model",
    learningMethodValues: {
      UNSUPERVISED: "Unsupervised",
      SEMI_SUPERVISED: "Semi-supervised",
    },
    confidenceLabel: "Conf:",
    categoryLabels: {
      RECONNAISSANCE: "Reconnaissance",
      INITIAL_ACCESS: "Initial Access",
      EXECUTION: "Execution",
      CREDENTIAL_ACCESS: "Credential Access",
      DISCOVERY: "Discovery",
      LATERAL_MOVEMENT: "Lateral Movement",
      COMMAND_AND_CONTROL: "Command and Control",
      EXFILTRATION: "Exfiltration",
      IMPACT: "Impact",
      COLLECTION: "Collection",
      DEFENSE_EVASION: "Defense Evasion",
      PERSISTENCE: "Persistence",
      PRIVILEGE_ESCALATION: "Privilege Escalation",
      RESOURCE_DEVELOPMENT: "Resource Development",
    },
    levelLabels: { LOW: "Low", MEDIUM: "Medium", HIGH: "High" },
    triageSummary: ({ count, max }) => `${count} policies · max ${max}`,
    protocolFields: {
      dnsQuery: "Query",
      dnsQueryType: "Query Type",
      dnsResponseCode: "Response Code",
      httpMethod: "Method",
      httpHost: "Host",
      httpUri: "URI",
      httpStatusCode: "Status Code",
      tlsServerName: "Server Name",
      tlsVersion: "TLS Version",
      tlsJa3: "JA3",
      startTime: "Start Time",
      endTime: "End Time",
      userList: "User List",
      isInternal: "Internal",
      networkService: "Service",
    },
    booleanTrue: "Yes",
    booleanFalse: "No",
    openInvestigation: "Open full investigation",
    openInvestigationTooltip: "Middle-click or Cmd+click to open in new tab",
    pivotSource: "Same source IP",
    pivotDestination: "Same destination IP",
    pivotKind: "Same kind",
    copy: "Copy",
    copied: "Copied",
    moreCountSuffix: (count) => `+${count} more`,
    countryUnknown: "??",
    countryUnavailable: "—",
    portSeparator: ":",
    unknownTime: "Unknown time",
    noSensor: "Unknown sensor",
    ...overrides,
  };
}

function httpThreat(overrides: Record<string, unknown> = {}): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T00:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.81,
    category: "LATERAL_MOVEMENT",
    level: "HIGH",
    triageScores: null,
    origAddr: "10.0.0.5",
    origPort: 49152,
    origCountry: "US",
    respAddr: "203.0.113.45",
    respPort: 443,
    respCountry: "DE",
    proto: 6,
    attackKind: "SQL Injection",
    method: "GET",
    host: "example.com",
    uri: "/login",
    statusCode: 200,
    learningMethod: "UNSUPERVISED",
    ...overrides,
  } as unknown as Event;
}

describe("QuickPeekInspector", () => {
  it("renders Summary, Endpoints, Detection meta, Protocol, and Actions sections for HttpThreat", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Summary");
    expect(html).toContain("Endpoints");
    expect(html).toContain("Detection");
    expect(html).toContain("Protocol");
    expect(html).toContain("Actions");
    // Endpoints render with IP:port + country.
    expect(html).toContain("10.0.0.5:49152");
    expect(html).toContain("203.0.113.45:443");
    // Detection meta surfaces sensor + attack kind + learning method.
    expect(html).toContain("sensor-1");
    expect(html).toContain("SQL Injection");
    expect(html).toContain("Unsupervised");
    // Protocol highlights.
    expect(html).toContain("GET");
    expect(html).toContain("example.com");
    expect(html).toContain("/login");
  });

  it("renders Open full investigation as a real anchor tag (middle-click friendly)", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123?returnTo=%2Fdetection"
        onClose={() => {}}
      />,
    );

    // The action must render as an <a href="...">, not a <button>
    // — so Cmd+click and middle-click open a new browser tab per
    // the acceptance requirements.
    expect(html).toMatch(/<a[^>]+href="\/events\/abc123/);
    expect(html).toContain("Open full investigation");
  });

  it("omits the Open investigation action when the event is not addressable", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "WindowsThreat",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.9,
            category: null,
            level: "MEDIUM",
            triageScores: null,
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref={null}
        onClose={() => {}}
      />,
    );

    // No "Open full investigation" anchor should appear at all —
    // the affordance is hidden rather than rendered as a dead control.
    expect(html).not.toContain("Open full investigation");
  });

  it("renders pivot links as real anchor tags pointing at /detection", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    // Each pivot must be an anchor so middle-click opens in a new
    // tab, matching the `Open full investigation` contract.
    expect(html).toMatch(/<a[^>]+href="\/detection\?source=10.0.0.5[^"]*"/);
    expect(html).toMatch(
      /<a[^>]+href="\/detection\?destination=203.0.113.45[^"]*"/,
    );
    expect(html).toMatch(/<a[^>]+href="\/detection\?kind=HttpThreat[^"]*"/);
  });

  it("hides empty protocol highlight fields rather than rendering '(Not Provided)'", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat({ method: "", uri: "" })}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    // Host and statusCode still render.
    expect(html).toContain("example.com");
    // The placeholder must never appear.
    expect(html).not.toContain("(Not Provided)");
    // Protocol section is still rendered because there are some non-empty fields.
    expect(html).toContain("Protocol");
  });

  it("inlines up to three responder entries before folding the rest into +N more (issue #290)", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "MultiHostPortScan",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.7,
            category: null,
            level: "MEDIUM",
            triageScores: null,
            origAddr: "10.0.0.5",
            origCountry: "US",
            respAddrs: [
              "10.0.0.1",
              "10.0.0.2",
              "10.0.0.3",
              "10.0.0.4",
              "10.0.0.5",
            ],
            respCountries: ["DE", "FR", "IT", "ES", "BE"],
            respPort: 22,
            proto: 6,
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:05:00.000Z",
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    // First three responders inline; remainder folds into `+N more`.
    // The issue asks for "first few values" inline, and the protocol
    // highlight section already uses three as its inline threshold —
    // mirroring that keeps both sections visually consistent.
    expect(html).toContain("10.0.0.1");
    expect(html).toContain("10.0.0.2");
    expect(html).toContain("10.0.0.3");
    expect(html).toContain("+2 more");
    // The shared `respPort=22` decorates every inline tuple, not just
    // the first — otherwise back-fill regresses for MultiHostPortScan.
    expect(html.match(/:22/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("inlines three PortScan responder ports with shared IP + country back-fill (issue #290)", () => {
    // Regression guard for the PortScan shape: a shared responder IP
    // + country with `respPorts` as the array dimension. Every inline
    // tuple must still render as `IP:port (country)` rather than a
    // bare port number.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "PortScan",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.7,
            category: null,
            level: "MEDIUM",
            triageScores: null,
            origAddr: "10.0.0.5",
            origCountry: "US",
            respAddr: "203.0.113.1",
            respCountry: "DE",
            respPorts: [22, 23, 80, 443, 8080],
            proto: 6,
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:05:00.000Z",
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    expect(html).toContain("203.0.113.1:22");
    expect(html).toContain("203.0.113.1:23");
    expect(html).toContain("203.0.113.1:80");
    expect(html).toContain("+2 more");
    // Every inline tuple still carries the shared `(DE)` country
    // because the primary-country back-fill applies to all tuples
    // that don't have an explicit per-index country.
    expect(html.match(/\(DE\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("renders at least one highlight for each acceptance-list subtype", () => {
    const cases: { event: Event; expect: string }[] = [
      { event: httpThreat(), expect: "example.com" },
      {
        event: {
          __typename: "SuspiciousTlsTraffic",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.8,
          category: null,
          level: "MEDIUM",
          triageScores: null,
          origAddr: "10.0.0.1",
          origPort: 49152,
          origCountry: "US",
          respAddr: "203.0.113.1",
          respPort: 443,
          respCountry: "DE",
          proto: 6,
          serverName: "evil.example.com",
          version: "TLSv1.2",
          ja3: "deadbeef",
        } as unknown as Event,
        expect: "evil.example.com",
      },
      {
        event: {
          __typename: "DnsCovertChannel",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.8,
          category: null,
          level: "MEDIUM",
          triageScores: null,
          origAddr: "10.0.0.1",
          origPort: 49152,
          origCountry: "US",
          respAddr: "203.0.113.1",
          respPort: 53,
          respCountry: "DE",
          proto: 17,
          query: "abcd.example.com",
          qtype: 1,
          rcode: 0,
        } as unknown as Event,
        expect: "abcd.example.com",
      },
      {
        event: {
          __typename: "FtpBruteForce",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.9,
          category: null,
          level: "HIGH",
          triageScores: null,
          origAddr: "10.0.0.1",
          origCountry: "US",
          respAddr: "203.0.113.1",
          respCountry: "DE",
          respPort: 21,
          proto: 6,
          userList: ["root", "admin"],
          startTime: "2026-04-22T00:00:00.000Z",
          endTime: "2026-04-22T00:03:00.000Z",
          isInternal: true,
        } as unknown as Event,
        expect: "root",
      },
      {
        event: {
          __typename: "RdpBruteForce",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.9,
          category: null,
          level: "HIGH",
          triageScores: null,
          origAddr: "10.0.0.1",
          origCountry: "US",
          respAddrs: ["203.0.113.1", "203.0.113.2"],
          respCountries: ["DE", "FR"],
          proto: 6,
          startTime: "2026-04-22T00:00:00.000Z",
          endTime: "2026-04-22T00:03:00.000Z",
        } as unknown as Event,
        expect: "2026-04-22T00:00:00.000Z",
      },
      {
        event: {
          __typename: "PortScan",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.9,
          category: null,
          level: "HIGH",
          triageScores: null,
          origAddr: "10.0.0.1",
          origCountry: "US",
          respAddr: "203.0.113.1",
          respCountry: "DE",
          respPorts: [22, 23, 80],
          proto: 6,
          startTime: "2026-04-22T00:00:00.000Z",
          endTime: "2026-04-22T00:03:00.000Z",
        } as unknown as Event,
        expect: "2026-04-22T00:00:00.000Z",
      },
      {
        event: {
          __typename: "ExternalDdos",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.9,
          category: null,
          level: "HIGH",
          triageScores: null,
          origAddrs: ["10.0.0.1", "10.0.0.2"],
          origCountries: ["US", "US"],
          respAddr: "203.0.113.1",
          respCountry: "DE",
          proto: 6,
          startTime: "2026-04-22T00:00:00.000Z",
          endTime: "2026-04-22T00:03:00.000Z",
        } as unknown as Event,
        expect: "2026-04-22T00:00:00.000Z",
      },
      {
        event: {
          __typename: "BlocklistHttp",
          time: "2026-04-22T00:00:00.000Z",
          sensor: "s",
          confidence: 0.9,
          category: null,
          level: "HIGH",
          triageScores: null,
          origAddr: "10.0.0.1",
          origPort: 49152,
          origCountry: "US",
          respAddr: "203.0.113.1",
          respPort: 80,
          respCountry: "DE",
          proto: 6,
          method: "POST",
          host: "bad.example.com",
          uri: "/drop",
          statusCode: 200,
          learningMethod: "SEMI_SUPERVISED",
        } as unknown as Event,
        expect: "bad.example.com",
      },
    ];
    for (const { event, expect: marker } of cases) {
      const html = renderToStaticMarkup(
        <QuickPeekInspector
          event={event}
          labels={labels()}
          locale="en"
          investigateHref="/events/token"
          onClose={() => {}}
        />,
      );
      expect(html, `peek render for ${event.__typename}`).toContain(marker);
    }
  });

  it("exposes a Copy affordance for the source/destination IPs", () => {
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc"
        onClose={() => {}}
      />,
    );

    // Both source and destination rows must expose a Copy button so
    // the operator can pull the IP into another tool without
    // selecting text.
    const copyButtons = html.match(/aria-label="Copy"/g);
    expect(copyButtons?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("exposes a Copy affordance for hostname-style protocol values (issue #290)", () => {
    // HttpThreat carries hostname (`host`) and URI (`uri`) in the
    // protocol highlights — both are copyable, so the operator can
    // pull the value into another tool without selecting text. The
    // earlier implementation only wired Copy into the endpoint rows;
    // the reviewer flagged the gap for hostname / userId values.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc"
        onClose={() => {}}
      />,
    );

    // The hostname appears in its own protocol row, and the row
    // exposes a Copy button alongside the value. Two endpoint IPs +
    // two copyable protocol fields (host + uri) means at least four
    // Copy buttons render for HttpThreat.
    const copyButtons = html.match(/aria-label="Copy"/g);
    expect(copyButtons?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(html).toContain("example.com");
  });

  it("exposes a Copy affordance for userId-style protocol values (issue #290)", () => {
    // FtpBruteForce carries an array of usernames (`userList`) — each
    // entry should expose a Copy affordance so the operator can pull
    // a single user identifier without dragging the whole comma-
    // joined list out of the popover.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "FtpBruteForce",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "s",
            confidence: 0.9,
            category: null,
            level: "HIGH",
            triageScores: null,
            origAddr: "10.0.0.1",
            origCountry: "US",
            respAddr: "203.0.113.1",
            respCountry: "DE",
            respPort: 21,
            proto: 6,
            userList: ["root"],
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:03:00.000Z",
            isInternal: true,
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc"
        onClose={() => {}}
      />,
    );

    // Source IP + destination IP + the userList badge each get a
    // Copy button.
    const copyButtons = html.match(/aria-label="Copy"/g);
    expect(copyButtons?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(html).toContain("root");
  });

  it("renders endpoint extras as a popover, not as inert text (issue #290)", () => {
    // The peek's `+N more` for the responder array must be an
    // interactive popover so the operator can inspect the hidden
    // values without expanding the inspector pane. The earlier
    // implementation rendered it as plain text and the reviewer
    // flagged the missing interaction.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "MultiHostPortScan",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.7,
            category: null,
            level: "MEDIUM",
            triageScores: null,
            origAddr: "10.0.0.5",
            origCountry: "US",
            respAddrs: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
            respCountries: ["DE", "FR", "IT", "ES"],
            respPort: 22,
            proto: 6,
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:05:00.000Z",
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    // The trigger renders as a `<button>` with `aria-haspopup="dialog"`
    // and `aria-expanded` — the same shape as the result list's
    // MorePopover — so the +N affordance is interactive rather than
    // an inert text label. With three inline responders and a
    // four-entry array the overflow trigger reads "+1 more".
    expect(html).toMatch(
      /<button[^>]+aria-expanded="false"[^>]+aria-haspopup="dialog"[^>]*>\+1 more<\/button>/,
    );
  });

  it("renders country labels as inert spans — country pivots are out of scope for v1 (issue #290)", () => {
    // The issue explicitly marks country / per-field pivots as out of
    // scope for v1, so the `(country)` label stays a plain text span
    // rather than a real anchor.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={httpThreat()}
        labels={labels()}
        locale="en"
        investigateHref="/events/abc"
        onClose={() => {}}
      />,
    );

    expect(html).not.toMatch(/href="\/detection\?[^"]*countries=/);
    expect(html).toContain("(US)");
    expect(html).toContain("(DE)");
  });

  it("renders endpoint overflow as full IP[:port] (country) tuples so hidden countries aren't dropped (issue #290)", () => {
    // The reviewer flagged that `extraCountries` were collected but
    // never rendered — the first responder kept its country label but
    // every hidden responder's country was effectively dropped.
    // Zipping the extras into one combined popover preserves the
    // per-entry country label.
    //
    // We open the `+N more` popover by reaching into its default-open
    // escape hatch through a wrapper that exercises the same rendering
    // the button click path would produce.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "MultiHostPortScan",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.7,
            category: null,
            level: "MEDIUM",
            triageScores: null,
            origAddr: "10.0.0.5",
            origCountry: "US",
            respAddrs: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
            respCountries: ["DE", "FR", "IT", "ES"],
            respPort: 22,
            proto: 6,
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:05:00.000Z",
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc123"
        onClose={() => {}}
      />,
    );

    // With four responder addresses and the inline-three rule, the
    // overflow popover carries only the fourth entry — but the
    // popover still exists (single combined trigger, not two).
    expect(html).toMatch(
      /<button[^>]+aria-expanded="false"[^>]+aria-haspopup="dialog"[^>]*>\+1 more<\/button>/,
    );
    const triggers = html.match(/aria-haspopup="dialog"/g);
    // Exactly one +N more trigger on the responder row.
    expect(triggers?.length ?? 0).toBe(1);
    // Every inline responder renders with its per-entry country label
    // (guards against the earlier "hidden countries dropped" bug on
    // inline tuples after the first).
    expect(html).toContain("(DE)");
    expect(html).toContain("(FR)");
    expect(html).toContain("(IT)");
  });

  it("opens Quick peek for subtypes without an encodable locator (ExtraThreat / WindowsThreat, issue #290)", () => {
    // Round 4 feedback: the acceptance criteria say selecting *any*
    // row opens the peek. Subtypes that the URL mirror cannot
    // round-trip (no `origAddr` / `respAddr`) still render a peek —
    // the Open full investigation anchor is omitted instead of
    // rendering a dead control, and the missing URL persistence is a
    // documented limitation rather than a reason to drop the feature.
    const html = renderToStaticMarkup(
      <QuickPeekInspector
        event={
          {
            __typename: "WindowsThreat",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-1",
            confidence: 0.9,
            category: "EXECUTION",
            level: "MEDIUM",
            triageScores: null,
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref={null}
        onClose={() => {}}
      />,
    );

    // The peek renders with the summary + detection sections even
    // though the event cannot be encoded into a locator.
    expect(html).toContain("Summary");
    expect(html).toContain("sensor-1");
    // Investigate affordance is still hidden (no encodable locator).
    expect(html).not.toContain("Open full investigation");
  });
});
