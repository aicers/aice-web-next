/**
 * The page-level callout reminds multi-tenant operators that the
 * page is aggregating data across more than one customer. Single-
 * customer assignments and admin sessions skip the callout — the
 * issue makes that an explicit acceptance line.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, string | number>): string => {
      if (!values) return key;
      const formatted = Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      return `${key}(${formatted})`;
    },
}));

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";

describe("CustomerScopeCallout", () => {
  it("renders for assigned scope with multiple customers", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeCallout
        scope={{
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
          ],
        }}
      />,
    );
    expect(html).toContain('data-testid="customer-scope-callout"');
    expect(html).toContain("callout(count=3)");
  });

  it("does not render for a single-customer assignment", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeCallout
        scope={{
          kind: "assigned",
          customers: [{ id: 1, name: "ACME" }],
        }}
      />,
    );
    expect(html).toBe("");
  });

  it("does not render for admin scope", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeCallout
        scope={{
          kind: "admin",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
          ],
        }}
      />,
    );
    expect(html).toBe("");
  });

  it("does not render for empty scope", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeCallout scope={{ kind: "empty", customers: [] }} />,
    );
    expect(html).toBe("");
  });
});
