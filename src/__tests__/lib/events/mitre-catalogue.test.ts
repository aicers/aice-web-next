import { describe, expect, it } from "vitest";

import { lookupMitreContext } from "@/lib/events/mitre-catalogue";

describe("lookupMitreContext", () => {
  it("resolves tactic from category and technique from attackKind", () => {
    const result = lookupMitreContext({
      __typename: "DnsCovertChannel",
      attackKind: "DNS Covert Channel",
      category: "COMMAND_AND_CONTROL",
    });
    expect(result).not.toBeNull();
    expect(result?.tacticId).toBe("TA0011");
    expect(result?.tacticName).toBe("Command and Control");
    expect(result?.techniqueId).toBe("T1071");
    expect(result?.techniqueName).toBe("Application Layer Protocol");
    expect(result?.subTechniqueId).toBe("T1071.004");
    expect(result?.subTechniqueName).toBe("DNS");
    expect(result?.explanation).toMatch(/DNS covert channel/i);
  });

  it("falls back to typename explanation when attackKind is unknown", () => {
    const result = lookupMitreContext({
      __typename: "PortScan",
      attackKind: "",
      category: "DISCOVERY",
    });
    expect(result).not.toBeNull();
    expect(result?.tacticId).toBe("TA0007");
    expect(result?.techniqueId).toBeUndefined();
    expect(result?.explanation).toMatch(/port scan/i);
  });

  it("returns just the tactic when only the category is recognized", () => {
    const result = lookupMitreContext({
      __typename: "UnknownEvent",
      attackKind: null,
      category: "EXFILTRATION",
    });
    expect(result).not.toBeNull();
    expect(result?.tacticId).toBe("TA0010");
    expect(result?.techniqueId).toBeUndefined();
    expect(result?.explanation).toBeUndefined();
  });

  it("returns null when nothing matches", () => {
    const result = lookupMitreContext({
      __typename: "UnknownEvent",
      attackKind: "nonsense",
      category: null,
    });
    expect(result).toBeNull();
  });

  it("matches attackKind case-insensitively and trims whitespace", () => {
    const result = lookupMitreContext({
      __typename: "FtpBruteForce",
      attackKind: "  FTP Brute Force  ",
      category: null,
    });
    expect(result?.techniqueId).toBe("T1110");
    expect(result?.subTechniqueId).toBe("T1110.001");
  });
});
