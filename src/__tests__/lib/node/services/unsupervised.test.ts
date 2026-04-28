import { describe, expect, it } from "vitest";

import {
  defaultUnsupervisedValues,
  deserialiseUnsupervised,
  serialiseUnsupervised,
} from "@/lib/node/services/unsupervised";

describe("Unsupervised (REconverge) module", () => {
  it("always serialises to the empty string", () => {
    expect(serialiseUnsupervised()).toBe("");
  });

  it("hydrates as an empty object", () => {
    expect(defaultUnsupervisedValues()).toEqual({});
    expect(deserialiseUnsupervised()).toEqual({});
  });

  it("produces the empty string (not null) on the wire", () => {
    const wire = serialiseUnsupervised();
    expect(wire).toBe("");
    expect(wire).not.toBeNull();
  });
});
