import { describe, expect, it, vi } from "vitest";

// Mock the React + UI deps so we can import the pure helper without
// pulling in JSX at test time.
vi.mock("react", () => ({
  useEffect: vi.fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  ExternalLink: () => null,
}));
vi.mock("@/components/ui/badge", () => ({ Badge: "span" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/popover", () => ({
  Popover: "div",
  PopoverContent: "div",
  PopoverTrigger: "div",
}));
// `@/i18n/navigation` pulls in `next-intl`'s navigation runtime, which
// expects Next.js's App Router context. Stub it to a plain anchor-like
// component so the module graph loads without bootstrapping Next.
vi.mock("@/i18n/navigation", () => ({ Link: "a" }));

import type { Event } from "@/lib/detection/types";

const labels = {
  openInvestigation: "Open investigation",
  confidence: "Confidence {value}",
  triageSummary: "{count} · {max}",
  unknownEndpoint: "—",
  attackKindLabel: "Attack: {kind}",
  moreCount: "+{count} more",
  moreAddressesTitle: "All addresses",
  moreAddressesCount: "{count} addresses",
  morePortsTitle: "All ports",
  morePortsCount: "{count} ports",
  rowTrigger:
    "Open Quick peek — {level} {kind} at {time}, {source} to {destination}, sensor {sensor}",
  pivotKind: "Pivot on kind {kind}",
  pivotSourceIp: "Pivot on source IP {value}",
  pivotDestinationIp: "Pivot on destination IP {value}",
  categoryLabels: {
    RECONNAISSANCE: "Reconnaissance",
    INITIAL_ACCESS: "Initial Access",
    EXECUTION: "Execution",
    CREDENTIAL_ACCESS: "Credential Access",
    DISCOVERY: "Discovery",
    LATERAL_MOVEMENT: "Lateral Movement",
    COMMAND_AND_CONTROL: "Command & Control",
    EXFILTRATION: "Exfiltration",
    IMPACT: "Impact",
    COLLECTION: "Collection",
    DEFENSE_EVASION: "Defense Evasion",
    PERSISTENCE: "Persistence",
    PRIVILEGE_ESCALATION: "Privilege Escalation",
    RESOURCE_DEVELOPMENT: "Resource Development",
  },
};

describe("summariseEvent", () => {
  it("renders a singular endpoint pair with port and country", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "BlocklistConn",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "sensor-a",
      confidence: 0.87,
      category: "INITIAL_ACCESS",
      level: "HIGH",
      triageScores: [
        { policyId: "p1", score: 0.5 },
        { policyId: "p2", score: 0.9 },
      ],
      origAddr: "10.0.0.5",
      origPort: 54321,
      origCountry: "US",
      respAddr: "203.0.113.45",
      respPort: 80,
      respCountry: "DE",
    } as unknown as Event;

    const summary = mod.summariseEvent(event, labels);
    expect(summary).toMatchObject({
      level: "HIGH",
      time: "2026-04-22T12:00:00.000Z",
      kind: "Blocklist Connection",
      attackKind: null,
      category: "Initial Access",
      confidence: "0.87",
      triage: { count: 2, maxLabel: "0.90" },
      source: "10.0.0.5:54321 (US)",
      destination: "203.0.113.45:80 (DE)",
      sensor: "sensor-a",
    });
  });

  it("emits +N more when responder addressing is an array", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "MultiHostPortScan",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.5,
      category: null,
      level: "MEDIUM",
      triageScores: null,
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddrs: ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
      respCountries: ["DE", "DE", "FR"],
      respPort: 22,
    } as unknown as Event;

    const summary = mod.summariseEvent(event, labels);
    expect(summary.destination).toBe("203.0.113.1:22 (DE) +2 more");
  });

  // Host-based subtypes `ExtraThreat` / `WindowsThreat` — documented
  // exception to #280's "every subtype renders source / destination
  // IP+port" rule. The REview schema exposes no `origAddr` / `respAddr`
  // for them (see schemas/review.graphql:3975 and :8104), so the row
  // falls back to the `unknownEndpoint` placeholder and the
  // Investigation affordance is suppressed. This test locks that
  // exception in so a future regression doesn't silently start
  // rendering garbage endpoints for those subtypes. See
  // `renders partial endpoints` tests below for the other documented
  // schema exceptions (`ExternalDdos`, `FtpBruteForce`,
  // `LdapBruteForce`, `RdpBruteForce`, `UnusualDestinationPattern`).
  it("falls back to '—' for host-based subtypes (ExtraThreat / WindowsThreat) that the schema gives no addressing", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "WindowsThreat",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.1,
      category: null,
      level: "LOW",
      triageScores: null,
      attackKind: "credential-dumping",
    } as unknown as Event;

    const summary = mod.summariseEvent(event, labels);
    expect(summary.source).toBe("—");
    expect(summary.destination).toBe("—");
    expect(summary.attackKind).toBe("credential-dumping");
  });

  // Documented schema-forced exceptions to the "every subtype renders
  // full `source IP:port → dest IP:port`" line. Each assertion mirrors
  // what the REview schema actually exposes for the subtype — port
  // suffix and country decoration are dropped only when the schema
  // itself has no field for them, so a future regression that swaps
  // fields around will surface as a failing assertion rather than a
  // silently degraded row.
  it("renders partial endpoints for subtypes the schema under-specifies", async () => {
    const mod = await import("@/components/detection/event-row");
    const baseCommon = {
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.3,
      category: null,
      level: "LOW",
      triageScores: null,
    };

    // ExternalDdos — origAddrs + respAddr + countries, no ports.
    const externalDdos = {
      ...baseCommon,
      __typename: "ExternalDdos",
      origAddrs: ["10.0.0.5"],
      origCountries: ["US"],
      respAddr: "203.0.113.10",
      respCountry: "DE",
    } as unknown as Event;
    const ddos = mod.summariseEvent(externalDdos, labels);
    expect(ddos.source).toBe("10.0.0.5 (US)");
    expect(ddos.destination).toBe("203.0.113.10 (DE)");

    // FtpBruteForce — origAddr but no origPort; respAddr + respPort.
    const ftp = {
      ...baseCommon,
      __typename: "FtpBruteForce",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: "203.0.113.10",
      respPort: 21,
      respCountry: "DE",
    } as unknown as Event;
    const ftpSummary = mod.summariseEvent(ftp, labels);
    expect(ftpSummary.source).toBe("10.0.0.5 (US)");
    expect(ftpSummary.destination).toBe("203.0.113.10:21 (DE)");

    // LdapBruteForce — same shape as FtpBruteForce (no origPort).
    const ldap = {
      ...baseCommon,
      __typename: "LdapBruteForce",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: "203.0.113.10",
      respPort: 389,
      respCountry: "DE",
    } as unknown as Event;
    const ldapSummary = mod.summariseEvent(ldap, labels);
    expect(ldapSummary.source).toBe("10.0.0.5 (US)");
    expect(ldapSummary.destination).toBe("203.0.113.10:389 (DE)");

    // RdpBruteForce — origAddr (no origPort) + respAddrs (no respPort).
    const rdp = {
      ...baseCommon,
      __typename: "RdpBruteForce",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddrs: ["203.0.113.10", "203.0.113.11"],
      respCountries: ["DE", "DE"],
    } as unknown as Event;
    const rdpSummary = mod.summariseEvent(rdp, labels);
    expect(rdpSummary.source).toBe("10.0.0.5 (US)");
    expect(rdpSummary.destination).toBe("203.0.113.10 (DE) +1 more");

    // UnusualDestinationPattern — no originator at all, only respAddrs.
    const unusual = {
      ...baseCommon,
      __typename: "UnusualDestinationPattern",
      respAddrs: ["203.0.113.10", "203.0.113.11"],
      respCountries: ["DE", "FR"],
    } as unknown as Event;
    const unusualSummary = mod.summariseEvent(unusual, labels);
    expect(unusualSummary.source).toBe("—");
    expect(unusualSummary.destination).toBe("203.0.113.10 (DE) +1 more");
  });

  it("returns null triage when there are no triage scores", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "PortScan",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.4,
      category: null,
      level: "LOW",
      triageScores: [],
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: "203.0.113.10",
      respCountry: "DE",
      respPorts: [22, 23, 25, 80, 443],
    } as unknown as Event;
    const summary = mod.summariseEvent(event, labels);
    expect(summary.triage).toBeNull();
    // PortScan has respPorts only — destination uses the first port +
    // an inline "+N more" for the rest.
    expect(summary.destination).toBe("203.0.113.10:22 (DE) +4 more");
  });
});

describe("resolveEndpoint", () => {
  it("renders the PortScan port overflow with the shared responder IP + country", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "PortScan",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.4,
      category: null,
      level: "LOW",
      triageScores: [],
      origAddr: "10.0.0.5",
      respAddr: "203.0.113.10",
      respCountry: "DE",
      respPorts: [22, 23, 25, 80, 443],
    } as unknown as Event;
    const dest = mod.resolveEndpoint(event, "resp", labels);
    expect(dest.overflowKind).toBe("port");
    // The popover keeps the shared responder IP + country so the
    // operator can scan the full endpoint (ip + port + country) for
    // every collapsed port, not just the port numbers.
    expect(dest.overflowEntries.map((e: { text: string }) => e.text)).toEqual([
      "203.0.113.10:22 (DE)",
      "203.0.113.10:23 (DE)",
      "203.0.113.10:25 (DE)",
      "203.0.113.10:80 (DE)",
      "203.0.113.10:443 (DE)",
    ]);
    // Every entry carries the shared responder IP so the popover row
    // can render it as a pivot link, matching the primary line.
    expect(
      dest.overflowEntries.every(
        (e: { ip: string }) => e.ip === "203.0.113.10",
      ),
    ).toBe(true);
    expect(dest.extras).toBe(4);
  });

  it("pairs per-index country and shared port for arrayed responder addressing", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "MultiHostPortScan",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.5,
      category: null,
      level: "MEDIUM",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddrs: ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
      respCountries: ["DE", "DE", "FR"],
      respPort: 22,
    } as unknown as Event;
    const dest = mod.resolveEndpoint(event, "resp", labels);
    expect(dest.overflowKind).toBe("address");
    expect(dest.overflowEntries.map((e: { text: string }) => e.text)).toEqual([
      "203.0.113.1:22 (DE)",
      "203.0.113.2:22 (DE)",
      "203.0.113.3:22 (FR)",
    ]);
    // Each overflow entry exposes its own IP so the popover row can
    // render a pivot link to that specific address — for
    // MultiHostPortScan the overflow is the only place these
    // additional IPs are shown.
    expect(dest.overflowEntries.map((e: { ip: string }) => e.ip)).toEqual([
      "203.0.113.1",
      "203.0.113.2",
      "203.0.113.3",
    ]);
    expect(dest.extras).toBe(2);
  });

  it("splits the primary line into IP / port suffix / country so the IP can render as a pivot link", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "BlocklistConn",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.1,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      origPort: 54321,
      origCountry: "US",
      respAddr: "203.0.113.45",
      respPort: 443,
      respCountry: "DE",
    } as unknown as Event;
    const src = mod.resolveEndpoint(event, "orig", labels);
    expect(src.primaryIp).toBe("10.0.0.5");
    expect(src.primaryPortSuffix).toBe(":54321");
    expect(src.primaryCountry).toBe("US");
    const dest = mod.resolveEndpoint(event, "resp", labels);
    expect(dest.primaryIp).toBe("203.0.113.45");
    expect(dest.primaryPortSuffix).toBe(":443");
    expect(dest.primaryCountry).toBe("DE");
  });

  it("returns a null primaryIp when the event carries no addressing (host-based subtypes)", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "WindowsThreat",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.1,
      category: null,
      level: "LOW",
      triageScores: null,
    } as unknown as Event;
    const src = mod.resolveEndpoint(event, "orig", labels);
    expect(src.primaryIp).toBeNull();
    expect(src.primaryPortSuffix).toBe("");
    expect(src.primaryCountry).toBeNull();
  });

  it("omits per-index country when the array is absent (RdpBruteForce)", async () => {
    const mod = await import("@/components/detection/event-row");
    const event = {
      __typename: "RdpBruteForce",
      time: "2026-04-22T12:00:00.000Z",
      sensor: "s",
      confidence: 0.5,
      category: null,
      level: "MEDIUM",
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddrs: ["203.0.113.1", "203.0.113.2"],
    } as unknown as Event;
    const dest = mod.resolveEndpoint(event, "resp", labels);
    expect(dest.overflowKind).toBe("address");
    // No shared port, no country array — entries are bare IPs.
    expect(dest.overflowEntries.map((e: { text: string }) => e.text)).toEqual([
      "203.0.113.1",
      "203.0.113.2",
    ]);
    // Each entry still exposes the IP separately so the popover row
    // can wrap it in a pivot link.
    expect(dest.overflowEntries.map((e: { ip: string }) => e.ip)).toEqual([
      "203.0.113.1",
      "203.0.113.2",
    ]);
  });
});
