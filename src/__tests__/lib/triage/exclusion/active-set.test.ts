import { describe, expect, it } from "vitest";

import { compileStoredRowsToActiveSet } from "@/lib/triage/exclusion/active-set";
import { computeExclusionsFingerprint } from "@/lib/triage/exclusion/fingerprint";

describe("compileStoredRowsToActiveSet", () => {
  it("emits one rule per (kind, value) row", () => {
    const set = compileStoredRowsToActiveSet([
      { kind: "hostname", value: "example.com" },
      { kind: "uri", value: "/foo" },
      { kind: "ipAddress", value: "10.0.0.0/24" },
      { kind: "domain", value: "^.*\\.example\\.com$" },
    ]);
    expect(set.rules).toHaveLength(4);
  });

  it("dedupes (kind, value) pairs that appear in both global and customer scope", () => {
    // Spec acceptance criterion (#457): "A test with a duplicate
    // (kind, value) across global and customer-scoped tables confirms
    // downstream matching de-duplicates."
    const set = compileStoredRowsToActiveSet([
      { kind: "hostname", value: "example.com" }, // global
      { kind: "hostname", value: "example.com" }, // customer (dup)
      { kind: "hostname", value: "other.example.com" }, // unique
    ]);
    expect(set.rules).toHaveLength(2);
  });

  it("yields a fingerprint independent of cross-scope duplication", () => {
    // The fingerprint feeds `baseline_corpus_state.exclusions_fp`; if
    // a (kind, value) collision flipped the digest, ops-promoting an
    // exclusion from customer-scoped to global would churn cadence
    // freshness for no semantic change.
    const single = computeExclusionsFingerprint(
      compileStoredRowsToActiveSet([{ kind: "hostname", value: "example.com" }])
        .rules,
    );
    const duplicated = computeExclusionsFingerprint(
      compileStoredRowsToActiveSet([
        { kind: "hostname", value: "example.com" },
        { kind: "hostname", value: "example.com" },
      ]).rules,
    );
    expect(duplicated).toBe(single);
  });

  it("treats different kinds with the same value as distinct rules", () => {
    const set = compileStoredRowsToActiveSet([
      { kind: "hostname", value: "example.com" },
      { kind: "domain", value: "example.com" },
    ]);
    expect(set.rules).toHaveLength(2);
  });
});
