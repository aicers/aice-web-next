import { describe, expect, it } from "vitest";

import { fromToml, toToml } from "@/lib/node/toml";

describe("toToml", () => {
  it("emits scalar fields in argument order with a trailing newline", () => {
    const out = toToml([
      ["name", "alpha"],
      ["port", 80],
      ["enabled", true],
    ]);
    expect(out).toBe('name = "alpha"\nport = 80\nenabled = true\n');
  });

  it("skips null and undefined entries (Rust Option::None semantics)", () => {
    const out = toToml([
      ["a", "x"],
      ["b", null],
      ["c", undefined],
      ["d", 1],
    ]);
    expect(out).toBe('a = "x"\nd = 1\n');
  });

  it("emits empty arrays as []", () => {
    const out = toToml([["protocols", []]]);
    expect(out).toBe("protocols = []\n");
  });

  it("emits string arrays with comma-space separator", () => {
    const out = toToml([["items", ["a", "b", "c"]]]);
    expect(out).toBe('items = ["a", "b", "c"]\n');
  });

  it("escapes backslashes and quotes in strings", () => {
    const out = toToml([["s", 'a"\\b']]);
    expect(out).toBe('s = "a\\"\\\\b"\n');
  });
});

describe("fromToml", () => {
  it("round-trips a flat document", () => {
    const text = 'a = "x"\nb = 5\nc = ["one", "two"]\n';
    const parsed = fromToml(text);
    expect(parsed).toEqual({ a: "x", b: 5, c: ["one", "two"] });
  });

  it("ignores comments and blank lines", () => {
    const text = "# top comment\n\na = 1  # trailing\n";
    expect(fromToml(text)).toEqual({ a: 1 });
  });

  it("rejects table headers — flat docs only", () => {
    expect(() => fromToml("[section]\n")).toThrow(/tables are not supported/i);
  });
});
