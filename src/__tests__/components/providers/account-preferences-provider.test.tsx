/**
 * Coverage for the server-seeding fix (#766, Reviewer Round 1 #3).
 *
 * `AccountPreferencesProvider` accepts a server-read `initialTimeFormat`
 * so the resolved format — and therefore the `<Timestamp>` placeholder
 * width — is correct on the very first paint, before the provider's own
 * `/api/accounts/me/preferences` fetch resolves. These tests pin that the
 * seed is reflected synchronously by `useResolvedTimeFormat()`, with the
 * network fetch held pending so only the seed can be observed.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
}));

import {
  AccountPreferencesProvider,
  useResolvedTimeFormat,
} from "@/components/providers/account-preferences-provider";
import type { StoredTimeFormat } from "@/lib/time-format";

function Probe() {
  const resolved = useResolvedTimeFormat();
  return <output data-testid="resolved">{JSON.stringify(resolved)}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccountPreferencesProvider — server seeding", () => {
  it("reflects the seeded preference on the first render (fetch pending)", () => {
    // Hold the self-fetch pending so the only value that can be observed
    // is the server-provided seed.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    const seed: StoredTimeFormat = {
      timeFormatLocale: "en-GB",
      timeFormatHourCycle: "h23",
      timeFormatSeconds: false,
      timeFormatTzLabel: true,
    };

    render(
      <AccountPreferencesProvider initialTimeFormat={seed}>
        <Probe />
      </AccountPreferencesProvider>,
    );

    expect(
      JSON.parse(screen.getByTestId("resolved").textContent ?? "{}"),
    ).toEqual({
      locale: "en-GB",
      hourCycle: "h23",
      seconds: false,
      tzLabel: true,
    });
  });

  it("falls back to the app default when no seed is supplied", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <AccountPreferencesProvider>
        <Probe />
      </AccountPreferencesProvider>,
    );

    expect(
      JSON.parse(screen.getByTestId("resolved").textContent ?? "{}"),
    ).toEqual({
      locale: undefined,
      hourCycle: undefined,
      seconds: true,
      tzLabel: false,
    });
  });
});
