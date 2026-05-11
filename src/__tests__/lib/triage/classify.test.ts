import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyTriageEndpoint,
  type TriageEvent,
  type TriageHostNetworkGroup,
} from "@/lib/triage";

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "NetworkThreat",
    id: `evt-${evSeq}`,
    time: "2026-05-09T12:00:00.000Z",
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ...overrides,
  };
}

function group(
  overrides: Partial<TriageHostNetworkGroup> = {},
): TriageHostNetworkGroup {
  return {
    hosts: [],
    networks: [],
    ranges: [],
    ...overrides,
  };
}

describe("classifyTriageEndpoint", () => {
  describe("customer-network-membership wins on the requested side", () => {
    it("classifies as internal when origAddr falls inside origNetwork CIDR", () => {
      const event = ev({
        origAddr: "203.0.113.5",
        origNetwork: { networks: group({ networks: ["203.0.113.0/24"] }) },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("internal");
    });

    it("classifies as internal when origAddr matches an exact host", () => {
      const event = ev({
        origAddr: "8.8.8.8",
        origNetwork: { networks: group({ hosts: ["8.8.8.8"] }) },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("internal");
    });

    it("classifies as internal when origAddr falls inside a range", () => {
      const event = ev({
        origAddr: "8.8.8.4",
        origNetwork: {
          networks: group({ ranges: [{ start: "8.8.8.1", end: "8.8.8.10" }] }),
        },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("internal");
    });

    it("classifies as external when origAddr is a public IP outside the customer network", () => {
      // Without metadata it would be external by RFC1918 fallback as
      // well, but the customer-metadata branch must reach the same
      // answer authoritatively rather than falling through.
      const event = ev({
        origAddr: "8.8.8.8",
        origNetwork: { networks: group({ networks: ["203.0.113.0/24"] }) },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("external");
    });

    it("classifies an RFC1918 address as external when customer metadata excludes it", () => {
      // Customer metadata is authoritative — so a 10.x address that
      // is NOT in the customer's defined network is external, even
      // though the RFC1918 fallback would have said internal.
      const event = ev({
        origAddr: "10.0.0.5",
        origNetwork: { networks: group({ networks: ["192.168.0.0/16"] }) },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("external");
    });
  });

  describe("RFC1918 / IPv6 fallback when no customer metadata is present", () => {
    it.each([
      ["10.0.0.1"],
      ["10.255.255.254"],
      ["172.16.0.1"],
      ["172.31.255.254"],
      ["192.168.1.1"],
      ["127.0.0.1"],
      ["169.254.10.10"],
      ["100.64.0.1"],
      ["100.127.255.254"],
    ])("classifies %s as internal", (addr) => {
      expect(classifyTriageEndpoint(ev({ origAddr: addr }), "orig")).toBe(
        "internal",
      );
    });

    it.each([
      ["::1"],
      ["fc00::1"],
      ["fd12:3456::1"],
      ["fe80::1"],
      ["fe80::abcd:1234"],
    ])("classifies IPv6 %s as internal", (addr) => {
      expect(classifyTriageEndpoint(ev({ origAddr: addr }), "orig")).toBe(
        "internal",
      );
    });

    it.each([
      ["8.8.8.8"],
      ["1.1.1.1"],
      ["172.32.0.1"],
      ["192.169.0.1"],
      ["100.128.0.1"],
      ["2001:db8::1"],
      ["2606:4700:4700::1111"],
    ])("classifies %s as external", (addr) => {
      expect(classifyTriageEndpoint(ev({ origAddr: addr }), "orig")).toBe(
        "external",
      );
    });
  });

  describe("unparseable addresses return unknown", () => {
    it.each([
      ["nonsense"],
      ["999.999.999.999"],
      ["10.0.0"],
      ["10.0.0.0.0"],
      ["10.0.0.-1"],
      [":::1"],
      ["g123::1"],
      [""],
    ])("classifies %s as unknown", (addr) => {
      expect(classifyTriageEndpoint(ev({ origAddr: addr }), "orig")).toBe(
        "unknown",
      );
    });

    it("classifies a missing origAddr as unknown", () => {
      expect(classifyTriageEndpoint(ev({ origAddr: undefined }), "orig")).toBe(
        "unknown",
      );
    });

    it("classifies a null origAddr as unknown", () => {
      expect(classifyTriageEndpoint(ev({ origAddr: null }), "orig")).toBe(
        "unknown",
      );
    });
  });

  describe("orig vs resp side selection cannot leak metadata across sides", () => {
    it("ignores respNetwork when classifying orig", () => {
      // origAddr is a public address that would be 'external' under
      // RFC1918 fallback. respNetwork lists it but origNetwork is
      // absent, so the orig side must NOT use respNetwork.
      const event = ev({
        origAddr: "8.8.8.8",
        respAddr: "10.0.0.1",
        respNetwork: { networks: group({ hosts: ["8.8.8.8"] }) },
      });
      expect(classifyTriageEndpoint(event, "orig")).toBe("external");
    });

    it("ignores origNetwork when classifying resp", () => {
      const event = ev({
        origAddr: "10.0.0.1",
        respAddr: "8.8.8.8",
        origNetwork: { networks: group({ hosts: ["8.8.8.8"] }) },
      });
      expect(classifyTriageEndpoint(event, "resp")).toBe("external");
    });

    it("classifies the resp side using respAddr + respNetwork", () => {
      const event = ev({
        origAddr: "8.8.8.8",
        respAddr: "203.0.113.5",
        respNetwork: { networks: group({ networks: ["203.0.113.0/24"] }) },
      });
      expect(classifyTriageEndpoint(event, "resp")).toBe("internal");
    });

    it("returns unknown for the resp side when respAddr is missing", () => {
      // RdpBruteForce / MultiHostPortScan etc. expose no respAddr.
      const event = ev({
        origAddr: "10.0.0.1",
        respAddr: undefined,
      });
      expect(classifyTriageEndpoint(event, "resp")).toBe("unknown");
    });
  });
});

describe("classifier import boundary", () => {
  // Guard rail for #476 §2: the classifier must be importable from
  // the client bundle. `src/lib/auth/cidr.ts` is `server-only` and
  // depends on `node:net`; if the classifier transitively pulled in
  // either, this would fail.
  it("does not declare a server-only side-effect or import node:net", () => {
    const sourcePath = path.resolve(
      __dirname,
      "../../../lib/triage/classify.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/from\s+["']server-only["']/);
    expect(source).not.toMatch(/import\s+["']server-only["']/);
    expect(source).not.toMatch(/from\s+["']node:net["']/);
    expect(source).not.toMatch(/from\s+["']node:/);
    // Reusing src/lib/auth/cidr.ts directly is forbidden — the whole
    // point of the fork is to avoid dragging the server-only boundary
    // into the client bundle.
    expect(source).not.toMatch(/from\s+["']@\/lib\/auth\/cidr["']/);
  });
});
