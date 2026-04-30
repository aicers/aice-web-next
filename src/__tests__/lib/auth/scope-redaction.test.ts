import { describe, expect, it } from "vitest";

import {
  formatScopedError,
  type Reference,
  redactForScope,
} from "@/lib/auth/scope-redaction";

describe("formatScopedError — single customer reference", () => {
  it("emits the literal when the referenced customer is in scope", () => {
    const out = formatScopedError(
      {
        template: 'Customer "{customer}" not found',
        references: [
          { kind: "customer", id: 5, placeholder: "customer", literal: "Acme" },
        ],
      },
      [5],
    );
    expect(out).toBe('Customer "Acme" not found');
  });

  it("redacts the literal when the referenced customer is out of scope", () => {
    const out = formatScopedError(
      {
        template: 'Customer "{customer}" not found',
        references: [
          { kind: "customer", id: 7, placeholder: "customer", literal: "Acme" },
        ],
      },
      [5],
    );
    expect(out).toBe('Customer "[redacted customer]" not found');
  });

  it("redacts when the allowed list is empty", () => {
    const out = formatScopedError(
      {
        template: "missing: {customer}",
        references: [
          { kind: "customer", id: 5, placeholder: "customer", literal: "Acme" },
        ],
      },
      [],
    );
    expect(out).toBe("missing: [redacted customer]");
  });
});

describe("formatScopedError — multiple references, mixed scope", () => {
  it("substitutes per-reference based on the allowed scope", () => {
    const out = formatScopedError(
      {
        template: "Sensor {sensor} (customer {customer}) at {addr} unreachable",
        references: [
          {
            kind: "sensor",
            customerId: 5,
            placeholder: "sensor",
            literal: "edge-1",
          },
          {
            kind: "customer",
            id: 7,
            placeholder: "customer",
            literal: "Globex",
          },
          {
            kind: "address",
            customerId: 5,
            placeholder: "addr",
            literal: "10.0.0.1",
          },
        ],
      },
      [5],
    );
    expect(out).toBe(
      "Sensor edge-1 (customer [redacted customer]) at 10.0.0.1 unreachable",
    );
  });

  it("emits every literal when every reference is in scope", () => {
    const out = formatScopedError(
      {
        template: "{a} / {b}",
        references: [
          { kind: "customer", id: 5, placeholder: "a", literal: "Acme" },
          { kind: "sensor", customerId: 5, placeholder: "b", literal: "s-1" },
        ],
      },
      [5, 6, 7],
    );
    expect(out).toBe("Acme / s-1");
  });

  it("redacts every literal when no reference is in scope", () => {
    const out = formatScopedError(
      {
        template: "{a} / {b}",
        references: [
          { kind: "customer", id: 9, placeholder: "a", literal: "Acme" },
          {
            kind: "address",
            customerId: 9,
            placeholder: "b",
            literal: "1.2.3.4",
          },
        ],
      },
      [5],
    );
    expect(out).toBe("[redacted customer] / [redacted address]");
  });
});

describe("formatScopedError — fallback / edge cases", () => {
  it("returns the template unchanged when references is empty", () => {
    const out = formatScopedError(
      { template: "no references here", references: [] },
      [5],
    );
    expect(out).toBe("no references here");
  });

  it("ignores references whose placeholder is absent from the template", () => {
    const out = formatScopedError(
      {
        template: "static",
        references: [
          { kind: "customer", id: 5, placeholder: "ghost", literal: "Acme" },
        ],
      },
      [5],
    );
    expect(out).toBe("static");
  });

  it("substitutes every occurrence of a repeated placeholder", () => {
    const out = formatScopedError(
      {
        template: "{c} and {c} again",
        references: [
          { kind: "customer", id: 5, placeholder: "c", literal: "Acme" },
        ],
      },
      [5],
    );
    expect(out).toBe("Acme and Acme again");
  });
});

describe("redactForScope — positional alias", () => {
  it("matches formatScopedError for the same input", () => {
    const refs: Reference[] = [
      { kind: "customer", id: 5, placeholder: "c", literal: "Acme" },
    ];
    expect(redactForScope("Customer {c}", refs, [5])).toBe(
      formatScopedError({ template: "Customer {c}", references: refs }, [5]),
    );
    expect(redactForScope("Customer {c}", refs, [])).toBe(
      formatScopedError({ template: "Customer {c}", references: refs }, []),
    );
  });
});
