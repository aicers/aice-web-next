import { describe, expect, it } from "vitest";

import {
  parseStoredExclusionInput,
  StoredExclusionValidationError,
} from "@/lib/triage/exclusion/storage-input";

describe("parseStoredExclusionInput", () => {
  describe("ipAddress", () => {
    it("upgrades a single IPv4 to /32", () => {
      const r = parseStoredExclusionInput({
        kind: "ipAddress",
        value: "192.168.1.5",
      });
      expect(r.value).toBe("192.168.1.5/32");
      expect(r.domainSuffix).toBeNull();
    });

    it("upgrades a single IPv6 to /128", () => {
      const r = parseStoredExclusionInput({
        kind: "ipAddress",
        value: "2001:db8::1",
      });
      expect(r.value).toBe("2001:db8::1/128");
    });

    it("zeroes host bits in CIDR", () => {
      const r = parseStoredExclusionInput({
        kind: "ipAddress",
        value: "192.168.1.5/24",
      });
      expect(r.value).toBe("192.168.1.0/24");
    });

    it("rejects invalid prefix", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "ipAddress",
          value: "192.168.1.0/33",
        }),
      ).toThrow(StoredExclusionValidationError);
    });

    it("rejects an unparseable IP", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "ipAddress",
          value: "not-an-ip",
        }),
      ).toThrow(StoredExclusionValidationError);
    });

    it("rejects IPv6 zone literals", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "ipAddress",
          value: "fe80::1%eth0",
        }),
      ).toThrow(StoredExclusionValidationError);
    });
  });

  describe("hostname", () => {
    it("lowercases and strips trailing dot", () => {
      const r = parseStoredExclusionInput({
        kind: "hostname",
        value: "Example.COM.",
      });
      expect(r.value).toBe("example.com");
    });

    it("rejects an empty hostname", () => {
      expect(() =>
        parseStoredExclusionInput({ kind: "hostname", value: "   " }),
      ).toThrow(StoredExclusionValidationError);
    });

    it("rejects invalid DNS labels", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "hostname",
          value: "bad_underscore.example",
        }),
      ).toThrow(StoredExclusionValidationError);
    });
  });

  describe("uri", () => {
    it("trims whitespace", () => {
      const r = parseStoredExclusionInput({
        kind: "uri",
        value: "  /admin/login  ",
      });
      expect(r.value).toBe("/admin/login");
    });

    it("rejects empty", () => {
      expect(() =>
        parseStoredExclusionInput({ kind: "uri", value: " " }),
      ).toThrow(StoredExclusionValidationError);
    });
  });

  describe("domain", () => {
    it("populates domain_suffix for the suffix shape", () => {
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^.*\\.example\\.com$",
      });
      expect(r.value).toBe("^.*\\.example\\.com$");
      expect(r.domainSuffix).toBe(".example.com");
    });

    it("populates exact-hostname domain_suffix", () => {
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^foo\\.example\\.com$",
      });
      expect(r.domainSuffix).toBe("foo.example.com");
    });

    it("populates suffix for the repeating-label shape", () => {
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^([a-z0-9-]+\\.)*example\\.com$",
      });
      expect(r.domainSuffix).toBe(".example.com");
    });

    it("leaves domain_suffix NULL for the [^.]+ shape — single-label is not retroactively reducible", () => {
      // Round 1 review for #457 found the SQL planner could not
      // express "exactly one label before the suffix" without
      // breaking the index plan; the reducer now returns null and the
      // pattern stays full-regex-only (forward matching applies).
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^[^.]+\\.example\\.com$",
      });
      expect(r.domainSuffix).toBeNull();
    });

    it("populates suffix for the .+ shape", () => {
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^.+\\.example\\.com$",
      });
      expect(r.domainSuffix).toBe(".example.com");
    });

    it("leaves domain_suffix NULL for non-reducible patterns", () => {
      const r = parseStoredExclusionInput({
        kind: "domain",
        value: "^(foo|bar)\\.example\\.com$",
      });
      expect(r.domainSuffix).toBeNull();
    });

    it("rejects engine-divergent shorthand", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "domain",
          value: "^\\d+$",
        }),
      ).toThrow(StoredExclusionValidationError);
    });

    it("rejects an uncompilable regex", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "domain",
          value: "(",
        }),
      ).toThrow(StoredExclusionValidationError);
    });
  });

  describe("note", () => {
    it("trims and stores the note", () => {
      const r = parseStoredExclusionInput({
        kind: "ipAddress",
        value: "10.0.0.1",
        note: "  fleet-internal  ",
      });
      expect(r.note).toBe("fleet-internal");
    });

    it("normalizes empty / whitespace-only note to null", () => {
      const r = parseStoredExclusionInput({
        kind: "ipAddress",
        value: "10.0.0.1",
        note: "   ",
      });
      expect(r.note).toBeNull();
    });
  });

  describe("kind validation", () => {
    it("rejects an unknown kind", () => {
      expect(() =>
        parseStoredExclusionInput({
          kind: "unknown-kind",
          value: "x",
        }),
      ).toThrow(StoredExclusionValidationError);
    });
  });

  it("rejects values longer than the cap", () => {
    expect(() =>
      parseStoredExclusionInput({
        kind: "uri",
        value: "x".repeat(1025),
      }),
    ).toThrow(StoredExclusionValidationError);
  });
});
