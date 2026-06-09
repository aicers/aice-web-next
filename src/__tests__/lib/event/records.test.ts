import { readFileSync } from "node:fs";
import path from "node:path";
import { type FieldNode, parse, visit } from "graphql";
import { describe, expect, it } from "vitest";

import {
  type BooleanLabels,
  formatFieldValue,
  type RecordDef,
  SYSMON_RECORD_DEFS,
} from "@/lib/event";
import type { SysmonRawEventConnection } from "@/lib/event/types";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const QUERIES_DIR = path.join(REPO_ROOT, "src/lib/event/queries");
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "src/__tests__/fixtures/event/sysmon",
);

const BOOLEAN_LABELS: BooleanLabels = { true: "Yes", false: "No" };

function kebab(id: string): string {
  return id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function loadFixtureConnection(def: RecordDef): SysmonRawEventConnection {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, `${def.id}.json`), "utf8"),
  ) as Record<string, SysmonRawEventConnection>;
  return raw[def.id];
}

/** Field names selected under the `node { ... }` of a query document. */
function nodeSelectionFields(graphql: string): string[] {
  const doc = parse(graphql);
  const fields: string[] = [];
  visit(doc, {
    Field(node: FieldNode) {
      if (node.name.value !== "node") return;
      for (const sel of node.selectionSet?.selections ?? []) {
        if (sel.kind === "Field") fields.push(sel.name.value);
      }
    },
  });
  return fields;
}

describe("sysmon record registry", () => {
  it("registers all 14 endpoint types as the sysmon family", () => {
    expect(SYSMON_RECORD_DEFS).toHaveLength(14);
    for (const def of SYSMON_RECORD_DEFS) {
      expect(def.family).toBe("sysmon");
    }
  });

  // Parametrized across every type (fixture-driven), not just a
  // representative few: the 14-type guarantees live here, per the issue.
  for (const def of SYSMON_RECORD_DEFS) {
    describe(def.id, () => {
      const connection = loadFixtureConnection(def);
      const node = connection.edges[0].node;

      it("the .graphql selection matches detailFields (no drift)", () => {
        const graphql = readFileSync(
          path.join(QUERIES_DIR, `${kebab(def.id)}.graphql`),
          "utf8",
        );
        const selected = nodeSelectionFields(graphql).sort();
        const declared = def.detailFields.map((f) => f.name).sort();
        expect(selected).toEqual(declared);
      });

      it("table columns are a subset of the detail fields", () => {
        const detailNames = new Set(def.detailFields.map((f) => f.name));
        for (const field of def.tableFields) {
          expect(detailNames.has(field.name)).toBe(true);
        }
      });

      it("every detail field maps to a fixture value and formats to a string", () => {
        for (const field of def.detailFields) {
          expect(node).toHaveProperty(field.name);
          const out = formatFieldValue(
            node[field.name],
            field.kind,
            BOOLEAN_LABELS,
          );
          expect(typeof out).toBe("string");
          expect(out).not.toBe("");
          // StringNumber* / Int values are shown as their string value,
          // never coerced to a JS number that could read as NaN.
          expect(out).not.toBe("NaN");

          if (field.kind === "boolean") {
            expect([BOOLEAN_LABELS.true, BOOLEAN_LABELS.false]).toContain(out);
          }
          if (field.kind === "list") {
            expect(Array.isArray(node[field.name])).toBe(true);
            expect(out).toBe((node[field.name] as string[]).join(", "));
          }
        }
      });

      it("exposes a Relay connection shape (result typing)", () => {
        expect(connection.pageInfo).toMatchObject({
          hasPreviousPage: expect.any(Boolean),
          hasNextPage: expect.any(Boolean),
        });
        expect(connection.edges.length).toBeGreaterThan(0);
        for (const edge of connection.edges) {
          expect(typeof edge.cursor).toBe("string");
          expect(typeof edge.node).toBe("object");
        }
      });
    });
  }
});
