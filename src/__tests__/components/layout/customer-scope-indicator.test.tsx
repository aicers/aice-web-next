/**
 * Acceptance coverage for the customer scope indicator (#383). Each
 * test renders the indicator with a mocked `EffectiveCustomerScope`
 * prop and asserts that the pill label and admin/empty visual cues
 * match the table in the issue body. The popover is exercised
 * separately by mounting `CustomerScopePopover` directly so the
 * 4+-customers list and source label are visible without simulating
 * a click. Tests render via `renderToStaticMarkup`, matching the
 * rest of the suite's SSR-only baseline.
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

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  CustomerScopeIndicator,
  CustomerScopePopover,
  formatScopeLabel,
} from "@/components/layout/customer-scope-indicator";

const t = (key: string, values?: Record<string, string | number>): string => {
  if (!values) return key;
  const formatted = Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  return `${key}(${formatted})`;
};

describe("formatScopeLabel", () => {
  it("renders the single-customer label", () => {
    expect(
      formatScopeLabel(
        { kind: "assigned", customers: [{ id: 1, name: "ACME" }] },
        t,
      ),
    ).toBe("single(name=ACME)");
  });

  it("joins names with commas for 2 customers", () => {
    expect(
      formatScopeLabel(
        {
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
          ],
        },
        t,
      ),
    ).toBe("few(names=ACME, Beta)");
  });

  it("joins names with commas for 3 customers", () => {
    expect(
      formatScopeLabel(
        {
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
          ],
        },
        t,
      ),
    ).toBe("few(names=ACME, Beta, Gamma)");
  });

  it("collapses to first + count for 4+ customers", () => {
    expect(
      formatScopeLabel(
        {
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
            { id: 4, name: "Delta" },
          ],
        },
        t,
      ),
    ).toBe("many(first=ACME,count=3)");
  });

  it("returns the all-customers label for admin scope", () => {
    expect(formatScopeLabel({ kind: "admin", customers: [] }, t)).toBe("all");
  });

  it("returns the empty label for an empty assignment", () => {
    expect(formatScopeLabel({ kind: "empty", customers: [] }, t)).toBe("empty");
  });

  it("renders the mobile single-customer label as just the name", () => {
    expect(
      formatScopeLabel(
        { kind: "assigned", customers: [{ id: 1, name: "ACME" }] },
        t,
        "mobile",
      ),
    ).toBe("mobileSingle(name=ACME)");
  });

  it("renders the mobile multi-customer label as a count pill", () => {
    expect(
      formatScopeLabel(
        {
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
          ],
        },
        t,
        "mobile",
      ),
    ).toBe("mobileCount(count=3)");
  });

  it("renders the mobile admin label as a count-style pill", () => {
    expect(
      formatScopeLabel({ kind: "admin", customers: [] }, t, "mobile"),
    ).toBe("mobileAll");
  });

  it("renders the mobile empty label as the warning short form", () => {
    expect(
      formatScopeLabel({ kind: "empty", customers: [] }, t, "mobile"),
    ).toBe("mobileEmpty");
  });
});

describe("CustomerScopeIndicator", () => {
  it("renders the single-customer pill with the name", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        scope={{ kind: "assigned", customers: [{ id: 1, name: "ACME" }] }}
      />,
    );
    expect(html).toContain('data-scope-kind="assigned"');
    expect(html).toContain("single(name=ACME)");
    // No admin badge for tenant scope.
    expect(html).not.toContain("adminBadge");
  });

  it("renders the few-customers pill with comma-joined names", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
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
    expect(html).toContain("few(names=ACME, Beta, Gamma)");
  });

  it("renders the +N more pill for 4+ customers", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        scope={{
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
            { id: 4, name: "Delta" },
            { id: 5, name: "Epsilon" },
          ],
        }}
      />,
    );
    expect(html).toContain("many(first=ACME,count=4)");
  });

  it("renders the admin badge for the access-all scope", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator scope={{ kind: "admin", customers: [] }} />,
    );
    expect(html).toContain("all");
    expect(html).toContain("adminBadge");
    expect(html).toContain('data-scope-kind="admin"');
  });

  it("renders the warning state for an empty scope", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator scope={{ kind: "empty", customers: [] }} />,
    );
    expect(html).toContain("empty");
    expect(html).toContain('data-scope-kind="empty"');
    // Empty scope must use the destructive (warning) styling so the
    // operator notices that the session has no tenant access.
    expect(html).toContain("destructive");
  });

  it("renders the mobile single-customer pill as a name-only chip", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        variant="mobile"
        scope={{ kind: "assigned", customers: [{ id: 1, name: "ACME" }] }}
      />,
    );
    expect(html).toContain('data-variant="mobile"');
    // Mobile single-customer must drop the "Customer:" prefix and
    // render the bare name so it fits the narrow header.
    expect(html).toContain("mobileSingle(name=ACME)");
    expect(html).not.toContain("single(name=ACME)");
  });

  it("renders the mobile multi-customer pill as a count chip", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        variant="mobile"
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
    // Mobile must NOT use the desktop comma-joined format that would
    // overflow a narrow viewport.
    expect(html).not.toContain("few(names=ACME, Beta, Gamma)");
    expect(html).toContain("mobileCount(count=3)");
  });

  it("renders the mobile admin pill as a count-style chip without the inline badge", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        variant="mobile"
        scope={{ kind: "admin", customers: [] }}
      />,
    );
    expect(html).toContain("mobileAll");
    expect(html).not.toContain("All customers");
    // The admin badge moves into the sheet header on mobile so the
    // pill itself stays compact.
    expect(html).not.toContain("adminBadge");
  });

  it("renders the mobile empty pill with the short warning label", () => {
    const html = renderToStaticMarkup(
      <CustomerScopeIndicator
        variant="mobile"
        scope={{ kind: "empty", customers: [] }}
      />,
    );
    expect(html).toContain("mobileEmpty");
    expect(html).toContain("destructive");
  });
});

describe("CustomerScopePopover", () => {
  it("lists every customer when the scope is enumerated", () => {
    const html = renderToStaticMarkup(
      <CustomerScopePopover
        scope={{
          kind: "assigned",
          customers: [
            { id: 1, name: "ACME" },
            { id: 2, name: "Beta" },
            { id: 3, name: "Gamma" },
            { id: 4, name: "Delta" },
          ],
        }}
        canManage
      />,
    );
    expect(html).toContain("ACME");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
    expect(html).toContain("Delta");
    expect(html).toContain("sourceAssigned");
  });

  it("labels admin scope source with the customers:access-all hint", () => {
    const html = renderToStaticMarkup(
      <CustomerScopePopover
        scope={{ kind: "admin", customers: [] }}
        canManage={false}
      />,
    );
    expect(html).toContain("sourceAdmin");
    expect(html).not.toContain("manageLink");
  });

  it("labels empty scope source with the no-customers hint", () => {
    const html = renderToStaticMarkup(
      <CustomerScopePopover
        scope={{ kind: "empty", customers: [] }}
        canManage={false}
      />,
    );
    expect(html).toContain("sourceEmpty");
  });

  it("includes the manage link when the operator has customers:read", () => {
    const html = renderToStaticMarkup(
      <CustomerScopePopover
        scope={{
          kind: "assigned",
          customers: [{ id: 1, name: "ACME" }],
        }}
        canManage
      />,
    );
    expect(html).toContain("manageLink");
    expect(html).toContain("/settings/customers");
  });
});
