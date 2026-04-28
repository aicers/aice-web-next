import type { ServiceFormModule } from "./types";

/**
 * REconverge (Unsupervised Engine) — informational only.
 *
 * The wire `draft` is always the empty string when this service is
 * enabled; there is no struct to build and there is no Configure-Here /
 * Configure-Manually toggle. The form layer renders a static panel; the
 * module exists so the registry can drive it the same way as the others.
 */

export type UnsupervisedFormValues = Record<string, never>;

export function defaultUnsupervisedValues(): UnsupervisedFormValues {
  return {};
}

export function serialiseUnsupervised(): string {
  return "";
}

export function deserialiseUnsupervised(): UnsupervisedFormValues {
  return {};
}

export const unsupervisedModule: ServiceFormModule<UnsupervisedFormValues> = {
  defaults: defaultUnsupervisedValues,
  serialise: serialiseUnsupervised,
  deserialise: deserialiseUnsupervised,
};
