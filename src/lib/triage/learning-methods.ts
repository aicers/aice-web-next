/**
 * Static-options registry for the Tier 2 `learningMethods` pivot
 * dimension (#498).
 *
 * The REview SDL defines `LearningMethod` as a fixed two-value enum
 * (`UNSUPERVISED`, `SEMI_SUPERVISED`). The Tier 2 panel surfaces both
 * as clickable rows in a dedicated static section that does not go
 * through the focus-driven `buildPivotPanel()` path — there is no
 * per-event extractor, so the section's row set is the enum itself.
 *
 * The panel renderer, the URL hash whitelist, and the tests all
 * import {@link LEARNING_METHOD_VALUES} from here so the two values
 * are defined once and any future schema addition is a single-line
 * change.
 */

export const LEARNING_METHOD_VALUES = [
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
] as const;

export type LearningMethodValue = (typeof LEARNING_METHOD_VALUES)[number];

const LEARNING_METHOD_VALUE_SET: ReadonlySet<string> = new Set(
  LEARNING_METHOD_VALUES,
);

export function isLearningMethodValue(
  value: string,
): value is LearningMethodValue {
  return LEARNING_METHOD_VALUE_SET.has(value);
}
