import { describe, expect, it } from "vitest";

import en from "@/i18n/messages/en.json";
import ko from "@/i18n/messages/ko.json";

function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      return getKeys(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

describe("translation messages", () => {
  it("en.json and ko.json have the same key structure", () => {
    const enKeys = getKeys(en);
    const koKeys = getKeys(ko);

    expect(enKeys).toEqual(koKeys);
  });

  it("contains required top-level namespaces", () => {
    const namespaces = Object.keys(en);

    expect(namespaces).toContain("common");
    expect(namespaces).toContain("auth");
    expect(namespaces).toContain("nav");
    expect(namespaces).toContain("settings");
    expect(namespaces).toContain("validation");
  });

  it("has no empty string values in en.json", () => {
    const values = getKeys(en).map(
      (key) =>
        key
          .split(".")
          .reduce(
            (obj, k) => (obj as Record<string, unknown>)[k],
            en as unknown,
          ) as string,
    );

    for (const value of values) {
      expect(value).not.toBe("");
    }
  });

  it("has no empty string values in ko.json", () => {
    const values = getKeys(ko).map(
      (key) =>
        key
          .split(".")
          .reduce(
            (obj, k) => (obj as Record<string, unknown>)[k],
            ko as unknown,
          ) as string,
    );

    for (const value of values) {
      expect(value).not.toBe("");
    }
  });
});
