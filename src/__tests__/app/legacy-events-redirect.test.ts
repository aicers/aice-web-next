import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRedirect = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/i18n/routing", () => ({
  routing: { defaultLocale: "en", locales: ["en", "ko"] },
}));

function buildToken(): string {
  const payload = { id: "evt-AAAA-BBBB-CCCC" };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function importPage() {
  return (await import("@/app/[locale]/(dashboard)/events/[token]/page"))
    .default;
}

beforeEach(() => {
  mockRedirect.mockReset();
  vi.resetModules();
});

describe("LegacyEventInvestigationRedirect", () => {
  it("redirects /events/<token> to /detection/events/<token> (default locale, no prefix)", async () => {
    const Page = await importPage();
    const token = buildToken();

    await Page({
      params: Promise.resolve({ locale: "en", token }),
      searchParams: Promise.resolve({}),
    });

    expect(mockRedirect).toHaveBeenCalledWith(
      `/detection/events/${encodeURIComponent(token)}`,
    );
  });

  it("prefixes the locale for non-default locales", async () => {
    const Page = await importPage();
    const token = buildToken();

    await Page({
      params: Promise.resolve({ locale: "ko", token }),
      searchParams: Promise.resolve({}),
    });

    expect(mockRedirect).toHaveBeenCalledWith(
      `/ko/detection/events/${encodeURIComponent(token)}`,
    );
  });

  it("preserves the query string (returnTo, customers, aimerForce)", async () => {
    const Page = await importPage();
    const token = buildToken();

    await Page({
      params: Promise.resolve({ locale: "en", token }),
      searchParams: Promise.resolve({
        returnTo: "/detection?source=10.0.0.5",
        customers: "c1,c2",
        aimerForce: "1",
      }),
    });

    const target = mockRedirect.mock.calls[0]?.[0] as string;
    const [path, search] = target.split("?");
    expect(path).toBe(`/detection/events/${encodeURIComponent(token)}`);

    const params = new URLSearchParams(search);
    expect(params.get("returnTo")).toBe("/detection?source=10.0.0.5");
    expect(params.get("customers")).toBe("c1,c2");
    expect(params.get("aimerForce")).toBe("1");
  });

  it("expands repeated (array) query values into multiple params", async () => {
    const Page = await importPage();
    const token = buildToken();

    await Page({
      params: Promise.resolve({ locale: "en", token }),
      searchParams: Promise.resolve({ customers: ["c1", "c2"] }),
    });

    const target = mockRedirect.mock.calls[0]?.[0] as string;
    const search = target.split("?")[1];
    expect(new URLSearchParams(search).getAll("customers")).toEqual([
      "c1",
      "c2",
    ]);
  });
});
