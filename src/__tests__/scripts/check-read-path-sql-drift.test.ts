import { describe, expect, it } from "vitest";

import { checkFiles } from "../../../scripts/check-read-path-sql-drift.mjs";

interface FixtureFile {
  relPath: string;
  source: string;
}

interface Violation {
  relPath: string;
  pattern: string;
}

function run(files: FixtureFile[]): Violation[] {
  return checkFiles(files) as Violation[];
}

describe("check-read-path-sql-drift guard", () => {
  it("flags an inlined `WITH scored AS (...) cume_dist() OVER (PARTITION BY ...)` copy", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/server-actions.ts",
        source: `await pool.query(\`WITH scored AS (
          SELECT cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score) AS s
            FROM baseline_triaged_event
        )\`);`,
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].pattern).toMatch(/WITH scored AS/);
  });

  it("flags an inlined `ROW_NUMBER() OVER (PARTITION BY orig_addr ...)` copy", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/server-actions.ts",
        source:
          "await pool.query(`SELECT ROW_NUMBER() OVER (PARTITION BY orig_addr ORDER BY event_time DESC) FROM x`);",
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].pattern).toMatch(/ROW_NUMBER\(\) OVER/);
  });

  it("flags a regressed `orig_addr::text = ANY(...)` cast", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/server-actions.ts",
        source:
          "await pool.query(`SELECT 1 WHERE orig_addr::text = ANY($1::text[])`);",
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].pattern).toMatch(/orig_addr::text = ANY/);
  });

  it("does not flag the shared module itself", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/baseline/read-path-sql.mjs",
        source: `export const X = \`WITH scored AS (
          SELECT cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score) AS s FROM baseline_triaged_event
        )\`;`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does not flag the sibling Story shared module", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/story/read-path-sql.mjs",
        source: `export const X = \`WITH scored AS (
          SELECT cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score) AS s FROM baseline_triaged_event
        )\`;`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does not flag test files (legitimate fixture SQL)", () => {
    const violations = run([
      {
        relPath: "src/__tests__/lib/triage/server-actions.test.ts",
        source: `mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
const sql = \`WITH scored AS (SELECT cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score) FROM x)\`;`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does not flag harness profile-assertion SQL (no measured-query shapes)", () => {
    const violations = run([
      {
        relPath: "scripts/measure-baseline-read-path/profile.mjs",
        source:
          "await pool.query(`SELECT COUNT(*) FROM baseline_triaged_event`);",
      },
    ]);

    // Bare table-name references are intentionally NOT flagged.
    expect(violations).toEqual([]);
  });

  it("flags the harness script if it inlines a measured-query shape", () => {
    const violations = run([
      {
        relPath: "scripts/measure-baseline-read-path.mjs",
        source: `await pool.query(\`WITH scored AS (
          SELECT cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score) AS s FROM baseline_triaged_event
        )\`);`,
      },
    ]);

    expect(violations).toHaveLength(1);
  });

  it("ignores patterns in `//` and `/* */` comments", () => {
    const violations = run([
      {
        relPath: "src/lib/triage/server-actions.ts",
        source: `// WITH scored AS ( cume_dist() OVER (PARTITION BY x)
/* ROW_NUMBER() OVER (PARTITION BY orig_addr ORDER BY 1) */
const v = 1;`,
      },
    ]);

    expect(violations).toEqual([]);
  });
});
