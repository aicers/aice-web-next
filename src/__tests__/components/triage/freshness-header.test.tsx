import { describe, expect, it } from "vitest";

import { _testing } from "@/components/triage/freshness-header";

const labels = {
  okTemplate: "Last updated: {ago}",
  runningWithPreviousTemplate: "Updating now (was {ago})",
  runningFirstIngest: "First ingest in progress",
  failedTemplate: "Last attempt failed {ago}",
  failedFirstIngest: "First ingest failed",
  awaitingFirstIngest: "Awaiting first ingest",
  okMultiTemplate: "Last updated: {ago}, across {count} customers",
  affectedCustomersHeading: "Affected",
  relative: {
    justNow: "just now",
    minutesTemplate: "{n} min ago",
    hoursTemplate: "{n} h ago",
    daysTemplate: "{n} d ago",
  },
};
const NOW = new Date("2026-05-09T12:00:00.000Z");

function ok(min: number) {
  return {
    customerId: 1,
    status: "ok" as const,
    lastIngestedAtIso: new Date(NOW.getTime() - min * 60 * 1000).toISOString(),
    rowAbsent: false,
    lastError: null,
  };
}

describe("renderWorstState", () => {
  it("ok with non-NULL last_ingested_at", () => {
    const r = _testing.renderWorstState(ok(5), [ok(5)], NOW, labels);
    expect(r.text).toBe("Last updated: 5 min ago");
    expect(r.tone).toBe("ok");
  });

  it("running with previous timestamp", () => {
    const c = { ...ok(5), status: "running" as const };
    const r = _testing.renderWorstState(c, [c], NOW, labels);
    expect(r.text).toBe("Updating now (was 5 min ago)");
    expect(r.tone).toBe("info");
  });

  it("running with NULL last_ingested_at = first ingest", () => {
    const c = {
      customerId: 1,
      status: "running" as const,
      lastIngestedAtIso: null,
      rowAbsent: false,
      lastError: null,
    };
    const r = _testing.renderWorstState(c, [c], NOW, labels);
    expect(r.text).toBe("First ingest in progress");
  });

  it("failed with non-NULL last_ingested_at", () => {
    const c = { ...ok(5), status: "failed" as const, lastError: "boom" };
    const r = _testing.renderWorstState(c, [c], NOW, labels);
    expect(r.text).toBe("Last attempt failed 5 min ago");
    expect(r.tone).toBe("warn");
    expect(r.tooltip).toBe("boom");
  });

  it("failed with NULL last_ingested_at = first-ingest failure", () => {
    const c = {
      customerId: 1,
      status: "failed" as const,
      lastIngestedAtIso: null,
      rowAbsent: false,
      lastError: "x",
    };
    const r = _testing.renderWorstState(c, [c], NOW, labels);
    expect(r.text).toBe("First ingest failed");
    expect(r.tone).toBe("warn");
  });

  it("rowAbsent renders awaiting-first-ingest", () => {
    const c = {
      customerId: 1,
      status: null,
      lastIngestedAtIso: null,
      rowAbsent: true,
      lastError: null,
    };
    const r = _testing.renderWorstState(c, [c], NOW, labels);
    expect(r.text).toBe("Awaiting first ingest");
    expect(r.tone).toBe("warn");
  });

  it("multi-customer ok summary template", () => {
    const customers = [ok(5), ok(10)];
    const r = _testing.renderWorstState(customers[1], customers, NOW, labels);
    expect(r.text).toBe("Last updated: 10 min ago, across 2 customers");
  });

  it("multi-customer failed row combines affected ids with last_error", () => {
    const okCustomer = ok(5);
    const failed = {
      customerId: 7,
      status: "failed" as const,
      lastIngestedAtIso: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
      rowAbsent: false,
      lastError: "ingest timed out",
    };
    const r = _testing.renderWorstState(
      failed,
      [okCustomer, failed],
      NOW,
      labels,
    );
    expect(r.text).toBe("Last attempt failed 10 min ago");
    expect(r.tone).toBe("warn");
    expect(r.tooltip).toBe("Affected: 7 — ingest timed out");
  });

  it("multi-customer failed first-ingest combines affected ids with last_error", () => {
    const okCustomer = ok(5);
    const failed = {
      customerId: 9,
      status: "failed" as const,
      lastIngestedAtIso: null,
      rowAbsent: false,
      lastError: "schema mismatch",
    };
    const r = _testing.renderWorstState(
      failed,
      [okCustomer, failed],
      NOW,
      labels,
    );
    expect(r.text).toBe("First ingest failed");
    expect(r.tooltip).toBe("Affected: 9 — schema mismatch");
  });

  it("multi-customer failed with no last_error falls back to affected ids only", () => {
    const okCustomer = ok(5);
    const failed = {
      customerId: 11,
      status: "failed" as const,
      lastIngestedAtIso: new Date(NOW.getTime() - 2 * 60 * 1000).toISOString(),
      rowAbsent: false,
      lastError: null,
    };
    const r = _testing.renderWorstState(
      failed,
      [okCustomer, failed],
      NOW,
      labels,
    );
    expect(r.tooltip).toBe("Affected: 11");
  });

  it("single-customer failed surfaces last_error without an affected list", () => {
    const failed = {
      customerId: 3,
      status: "failed" as const,
      lastIngestedAtIso: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      rowAbsent: false,
      lastError: "boom",
    };
    const r = _testing.renderWorstState(failed, [failed], NOW, labels);
    expect(r.tooltip).toBe("boom");
  });
});
