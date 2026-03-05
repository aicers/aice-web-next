import { describe, expect, it } from "vitest";

import { assessIpUaRisk } from "@/lib/auth/session-validator";

describe("assessIpUaRisk", () => {
  const base = {
    storedIp: "192.168.1.1",
    currentIp: "192.168.1.1",
    storedBrowserFingerprint: "Chrome/131",
    currentBrowserFingerprint: "Chrome/131",
  };

  it("returns no risk when nothing changed", () => {
    const result = assessIpUaRisk(base);

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("none");
    expect(result.auditActions).toEqual([]);
  });

  it("IP only changed (UA same) → low risk, proceed", () => {
    const result = assessIpUaRisk({
      ...base,
      currentIp: "10.0.0.1",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("low");
    expect(result.auditActions).toEqual(["session.ip_mismatch"]);
  });

  it("UA minor version change (IP same) → low risk, proceed", () => {
    const result = assessIpUaRisk({
      ...base,
      currentBrowserFingerprint: "Chrome/132",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("low");
    expect(result.auditActions).toEqual(["session.ua_mismatch"]);
  });

  it("UA major change (IP same) → medium risk, require re-auth", () => {
    const result = assessIpUaRisk({
      ...base,
      currentBrowserFingerprint: "Firefox/133",
    });

    expect(result.proceed).toBe(false);
    expect(result.requiresReauth).toBe(true);
    expect(result.riskLevel).toBe("medium");
    expect(result.auditActions).toEqual(["session.ua_mismatch"]);
  });

  it("IP + UA both changed → high risk, require re-auth", () => {
    const result = assessIpUaRisk({
      ...base,
      currentIp: "10.0.0.1",
      currentBrowserFingerprint: "Firefox/133",
    });

    expect(result.proceed).toBe(false);
    expect(result.requiresReauth).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.auditActions).toEqual([
      "session.ip_mismatch",
      "session.ua_mismatch",
    ]);
  });

  it("empty stored fingerprint (legacy session) → skips UA comparison", () => {
    const result = assessIpUaRisk({
      ...base,
      storedBrowserFingerprint: "",
      currentBrowserFingerprint: "Firefox/133",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("none");
    expect(result.auditActions).toEqual([]);
  });

  it("empty stored fingerprint + IP change → only IP mismatch", () => {
    const result = assessIpUaRisk({
      ...base,
      storedBrowserFingerprint: "",
      currentIp: "10.0.0.1",
      currentBrowserFingerprint: "Firefox/133",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("low");
    expect(result.auditActions).toEqual(["session.ip_mismatch"]);
  });

  it("'unknown' IP is treated as unchanged", () => {
    const result = assessIpUaRisk({
      ...base,
      storedIp: "unknown",
      currentIp: "10.0.0.1",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("none");
    expect(result.auditActions).toEqual([]);
  });

  it("IP change + UA minor change → low risk, proceed", () => {
    const result = assessIpUaRisk({
      ...base,
      currentIp: "10.0.0.1",
      currentBrowserFingerprint: "Chrome/132",
    });

    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("low");
    expect(result.auditActions).toEqual([
      "session.ip_mismatch",
      "session.ua_mismatch",
    ]);
  });

  it("current IP 'unknown' is treated as unchanged", () => {
    const result = assessIpUaRisk({
      ...base,
      storedIp: "192.168.1.1",
      currentIp: "unknown",
    });

    expect(result.proceed).toBe(true);
    expect(result.riskLevel).toBe("none");
    expect(result.auditActions).toEqual([]);
  });

  it("both IPs 'unknown' treated as no change", () => {
    const result = assessIpUaRisk({
      ...base,
      storedIp: "unknown",
      currentIp: "unknown",
    });

    expect(result.proceed).toBe(true);
    expect(result.riskLevel).toBe("none");
    expect(result.auditActions).toEqual([]);
  });

  it("legacy session (empty fingerprint) with IP change + UA major → only IP mismatch (low)", () => {
    const result = assessIpUaRisk({
      storedIp: "192.168.1.1",
      currentIp: "10.0.0.1",
      storedBrowserFingerprint: "",
      currentBrowserFingerprint: "Firefox/133",
    });

    // Empty fingerprint forces UA to "same", so only IP changed
    expect(result.proceed).toBe(true);
    expect(result.requiresReauth).toBe(false);
    expect(result.riskLevel).toBe("low");
    expect(result.auditActions).toEqual(["session.ip_mismatch"]);
  });
});
