import { describe, expect, it } from "vitest";

import { compileStoredRowsToActiveSet } from "@/lib/triage/exclusion/active-set";

describe("compileStoredRowsToActiveSet — scope-aware snapshot emission (#472)", () => {
  it("co-emits snapshotRows when input rows carry a scope label", () => {
    const set = compileStoredRowsToActiveSet([
      { scope: "global", kind: "hostname", value: "example.com" },
      { scope: "customer", kind: "ipAddress", value: "10.0.0.0/24" },
    ]);
    expect(set.snapshotRows).toEqual([
      { scope: "global", kind: "hostname", value: "example.com" },
      { scope: "customer", kind: "ipAddress", value: "10.0.0.0/24" },
    ]);
  });

  it("dedup keeps the first-seen scope label (global → customer ordering)", () => {
    // The storage resolver emits global rows before customer rows;
    // the snapshot row must therefore carry scope='global'.
    const set = compileStoredRowsToActiveSet([
      { scope: "global", kind: "hostname", value: "example.com" },
      { scope: "customer", kind: "hostname", value: "example.com" },
    ]);
    expect(set.snapshotRows).toHaveLength(1);
    expect(set.snapshotRows?.[0]).toEqual({
      scope: "global",
      kind: "hostname",
      value: "example.com",
    });
    // Matcher dedup is unchanged: one rule fires.
    expect(set.rules).toHaveLength(1);
  });

  it("leaves snapshotRows undefined when no input row carries scope (legacy callers)", () => {
    const set = compileStoredRowsToActiveSet([
      { kind: "hostname", value: "example.com" },
      { kind: "uri", value: "/foo" },
    ]);
    expect(set.snapshotRows).toBeUndefined();
    expect(set.rules).toHaveLength(2);
  });
});
