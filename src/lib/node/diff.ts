/**
 * Per-service diff utility (Phase Node-9d, #362).
 *
 * Returns the changed fields between an `applied` and `draft` payload
 * for a given service kind. Each entry is `{ fieldPath, applied, draft }`,
 * where `fieldPath` is the wire-level key the service emits in its TOML
 * draft (e.g. `ingest_srv_addr`, `protocols`). Unchanged fields are
 * omitted.
 *
 * Inputs are the wire strings stored as `appliedConfig` / `draft` on
 * the canonical Node payload (see `src/lib/node/types.ts`):
 *
 *   - `null` means "no value on this side" (e.g. a brand-new draft has
 *     no `applied` counterpart, or an applied service that has no
 *     pending draft on the wire).
 *   - "" (empty string) is the canonical wire shape for the
 *     informational-only Unsupervised Engine and is treated as no
 *     fields.
 *
 * Output shape:
 *
 *   - `applied` / `draft` on each entry is the rendered scalar form
 *     used by the wire (TOML literal). For arrays the renderer joins
 *     the items with `", "` so the diff reads naturally in the modal /
 *     detail-page UI without forcing every consumer to interpret the
 *     TOML grammar.
 *   - A field that exists only on one side carries `null` on the other
 *     side. The fieldPath is still listed; the consumer can render
 *     `(unset)` etc. as appropriate.
 *
 * The utility is intentionally service-agnostic: it parses both sides
 * with the shared `fromToml` helper and walks the union of keys. This
 * keeps the surface a single function regardless of which service
 * kind feeds it — the `fromToml` parser already understands the
 * scalar / array shapes every service emits.
 */

import { fromToml, type TomlScalar } from "./toml";

export interface ServiceDiffEntry {
  /**
   * Wire-level key of the changed field. Matches the TOML key the
   * per-service `serialise` function emits (e.g. `ingest_srv_addr`,
   * `protocols`, `dump_items`).
   */
  fieldPath: string;
  /**
   * Rendered scalar form of the applied value; `null` when the field
   * is absent from the applied side.
   */
  applied: string | null;
  /**
   * Rendered scalar form of the draft value; `null` when the field is
   * absent from the draft side.
   */
  draft: string | null;
}

/**
 * Compute the per-service diff between an applied wire string and a
 * draft wire string.
 *
 * Both inputs may be `null` (no value on that side) or "" (empty
 * draft). The function returns an array of changed fields in the
 * order their keys first appear (applied keys in serialise order,
 * followed by draft-only keys in serialise order) so the caller can
 * render the diff with stable ordering.
 *
 * Equality is structural:
 *
 *   - Scalars are compared by their wire literal. A draft that flips
 *     `pcap_max_size = 1000` to `1000` is *not* a change, regardless
 *     of whitespace differences in the TOML source.
 *   - Arrays are compared element-by-element in order. A wire array
 *     is order-significant on the upstream side
 *     (`protocols = ["dns", "http"]` is a different wire payload from
 *     `["http", "dns"]`); a reorder is therefore reported as a change.
 */
export function diffServiceConfig(
  applied: string | null | undefined,
  draft: string | null | undefined,
): ServiceDiffEntry[] {
  const appliedRaw = applied ?? "";
  const draftRaw = draft ?? "";
  if (appliedRaw === "" && draftRaw === "") return [];

  const appliedRecord = appliedRaw === "" ? {} : fromToml(appliedRaw);
  const draftRecord = draftRaw === "" ? {} : fromToml(draftRaw);

  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(appliedRecord)) {
    if (!seen.has(key)) {
      seen.add(key);
      orderedKeys.push(key);
    }
  }
  for (const key of Object.keys(draftRecord)) {
    if (!seen.has(key)) {
      seen.add(key);
      orderedKeys.push(key);
    }
  }

  const result: ServiceDiffEntry[] = [];
  for (const key of orderedKeys) {
    const inApplied = Object.hasOwn(appliedRecord, key);
    const inDraft = Object.hasOwn(draftRecord, key);
    const appliedValue = inApplied ? appliedRecord[key] : undefined;
    const draftValue = inDraft ? draftRecord[key] : undefined;
    if (inApplied && inDraft && valuesEqual(appliedValue, draftValue)) {
      continue;
    }
    result.push({
      fieldPath: key,
      applied: inApplied ? renderValue(appliedValue) : null,
      draft: inDraft ? renderValue(draftValue) : null,
    });
  }
  return result;
}

function valuesEqual(
  a: TomlScalar | TomlScalar[] | undefined,
  b: TomlScalar | TomlScalar[] | undefined,
): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return false;
}

function renderValue(value: TomlScalar | TomlScalar[] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) {
    // Render explicit empty arrays as the TOML wire literal `[]` so the
    // diff preserves the asymmetric empty-list rule in
    // `src/lib/node/services/empty-list.ts`: a missing key means "all
    // enabled", while `[]` means "enable none". Collapsing to `""` here
    // would render that intentional change blank in the diff UI.
    if (value.length === 0) return "[]";
    return value.map(renderScalar).join(", ");
  }
  return renderScalar(value);
}

function renderScalar(value: TomlScalar): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
