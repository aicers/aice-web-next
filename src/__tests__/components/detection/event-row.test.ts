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

  it("falls back to the unknown-endpoint placeholder when no addressing exists", async () => {
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
    expect(dest.overflowEntries).toEqual([
      "203.0.113.10:22 (DE)",
      "203.0.113.10:23 (DE)",
      "203.0.113.10:25 (DE)",
      "203.0.113.10:80 (DE)",
      "203.0.113.10:443 (DE)",
    ]);
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
    expect(dest.overflowEntries).toEqual([
      "203.0.113.1:22 (DE)",
      "203.0.113.2:22 (DE)",
      "203.0.113.3:22 (FR)",
    ]);
    expect(dest.extras).toBe(2);
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
    expect(dest.overflowEntries).toEqual(["203.0.113.1", "203.0.113.2"]);
  });
});
