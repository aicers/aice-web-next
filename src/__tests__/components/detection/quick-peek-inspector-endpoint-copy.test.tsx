/**
 * Quick peek endpoint overflow copy wiring (issue #290).
 *
 * The inspector SSR tests render with `MorePopover` in its closed
 * state, so they cannot observe what the popover's Copy buttons emit
 * to the clipboard. This file stubs `MorePopover` with a capture
 * component so we can assert the props the inspector hands down:
 *
 * - `copyLabels` is supplied (so overflow items render Copy buttons).
 * - `copyValues` carries the raw IP per overflow entry — the payload
 *   that Copy should actually put on the clipboard — while `values`
 *   keeps the `IP[:port] (country)` display string.
 *
 * Lives in its own file so the `MorePopover` mock does not leak into
 * the broader inspector rendering suite, which exercises the real
 * popover trigger shape.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

type MorePopoverProps = {
  count: number;
  values: string[];
  copyValues?: string[];
  copyLabels?: { copy: string; copied: string };
  moreCountSuffix: (count: number) => string;
};

const capturedProps: MorePopoverProps[] = [];

vi.mock("@/components/detection/more-popover", () => ({
  MorePopover: (props: MorePopoverProps) => {
    capturedProps.push(props);
    return <span data-more-popover-stub="true" />;
  },
}));

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

function labels(): QuickPeekInspectorLabels {
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
    levelLabels: {
      VERY_LOW: "Very Low",
      LOW: "Low",
      MEDIUM: "Medium",
      HIGH: "High",
      VERY_HIGH: "Very High",
    },
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
  };
}

describe("QuickPeekInspector — endpoint overflow Copy wiring", () => {
  it("passes raw IPs through copyValues and supplies copyLabels (issue #290)", () => {
    capturedProps.length = 0;
    renderToStaticMarkup(
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
              "203.0.113.1",
              "203.0.113.2",
              "203.0.113.3",
              "203.0.113.4",
              "203.0.113.5",
            ],
            respCountries: ["DE", "FR", "IT", "ES", "NL"],
            respPort: 22,
            proto: 6,
            startTime: "2026-04-22T00:00:00.000Z",
            endTime: "2026-04-22T00:05:00.000Z",
          } as unknown as Event
        }
        labels={labels()}
        locale="en"
        investigateHref="/events/abc"
        onClose={() => {}}
      />,
    );

    // The responder row hands exactly two overflow entries
    // (tuples 4 and 5) through the popover.
    const overflowCall = capturedProps.find((p) => p.count === 2);
    expect(
      overflowCall,
      "endpoint overflow popover was rendered",
    ).toBeDefined();
    if (!overflowCall) return;

    // Copy affordance is enabled inside the popover — the reviewer's
    // Round 12 gap.
    expect(overflowCall.copyLabels).toEqual({ copy: "Copy", copied: "Copied" });

    // Displayed values keep the country suffix; copy payload is the
    // bare IP so clipboard-into-another-tool works without stripping.
    expect(overflowCall.values).toEqual([
      "203.0.113.4:22 (ES)",
      "203.0.113.5:22 (NL)",
    ]);
    expect(overflowCall.copyValues).toEqual(["203.0.113.4", "203.0.113.5"]);
  });
});
