/**
 * Empty-list normalisation rule shared by Piglet `protocols`,
 * `dump_items`, `dump_http_content_types`, and Hog `active_protocols`,
 * `active_sensors`, `active_models`.
 *
 * Mirrors aice-web's `fetch.rs` helper at lines 1665–1674. The mapping
 * is **asymmetric** — `null` means "all enabled" and is distinct from
 * `[]` (empty array) which means "enable none". The catalog hint
 * "leave all checked to enable everything" only kicks in when the
 * caller actually checked every option.
 *
 * The all-checked test is **set-equality** between the deduplicated
 * valid selections and the full pool — never raw array length.
 * Trusting the count alone lets a malformed draft with one duplicate
 * and one missing entry sneak past as "all checked" and silently
 * broaden the wire shape on the next save.
 */
export function normaliseChecklist<T>(
  selected: readonly T[],
  full: readonly T[],
): T[] | undefined {
  const fullSet = new Set<T>(full);
  const validUnique = new Set<T>();
  for (const item of selected) {
    if (fullSet.has(item)) validUnique.add(item);
  }
  if (validUnique.size === fullSet.size) return undefined; // all checked → None
  return [...selected]; // partial or zero → Some([...])
}

/**
 * Inverse of {@link normaliseChecklist} for hydration. A wire `null`
 * (absent key) hydrates as "every option checked"; an explicit empty
 * array hydrates as "nothing checked"; a partial array hydrates verbatim.
 */
export function hydrateChecklist<T>(
  wire: readonly T[] | undefined,
  full: readonly T[],
): T[] {
  if (wire === undefined) return [...full];
  return [...wire];
}
