/**
 * Shared neutral-card surface look for the compact Triage/Aimer panels.
 *
 * These screens build their cards by hand instead of using the shared `<Card>`
 * (which has a larger `rounded-xl` geometry and `py-6`/`px-6` padding). This
 * token single-sources only the surface look that drifted in #197/#669 —
 * callers keep their own padding/gap/layout inline, e.g. `cn(panelSurface,
 * "p-4")`. Keeping it a plain string (no `cva`) is enough: there are no
 * variants.
 */
export const panelSurface = "rounded-md bg-card";
