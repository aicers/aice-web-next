/**
 * Render-level coverage for {@link AimerIntegrationPanel} (Reviewer
 * Round 1, #437).
 *
 * The lower-level helper / state-machine tests already cover the
 * pure logic.  Two component-specific behaviors are easy to regress
 * and not visible from those tests:
 *
 * 1. After a successful PATCH on `clumit_insight_bridge_url`, the input
 *    draft must reset to the server-normalized canonical value (the
 *    server strips trailing slashes).  Without this sync the input
 *    would keep the original "https://aimer.example.com/" the
 *    operator typed and the Save button would stay enabled, even
 *    though the saved value is "https://aimer.example.com".
 *
 * 2. The customer external_key informational line renders the real
 *    `configured / total` counter from the page query.  Reviewer
 *    Round 1 caught the prior hard-coded `0` numerator; the
 *    regression guard renders both an in-progress rollout (M / N)
 *    and an empty-rollout state (0 / N) to prove the numerator is
 *    not constant.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `aimer-integration-panel.tsx` imports `Link` from `@/i18n/navigation`
// which transitively pulls in `next/navigation`'s ESM build; stub both
// so the jsdom environment can resolve the import.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

import { AimerIntegrationPanel } from "@/components/settings/aimer-integration-panel";
import enMessages from "@/i18n/messages/en.json";
import type { AimerIntegrationSetup } from "@/lib/aimer/setup-status";
import type {
  AimerSigningKeyPublicEntry,
  AimerSigningKeyStatus,
} from "@/lib/aimer/signing-key";

const EMPTY_KEY_STATUS: AimerSigningKeyStatus = {
  state: "empty",
  active: null,
  pending: null,
  previous: null,
  filePermissionAlert: false,
  observedFilePermission: null,
};

function activeEntry(
  recommendedRotationAt: string,
): AimerSigningKeyPublicEntry {
  return {
    kid: "test-kid",
    algorithm: "ES256",
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    thumbprintBase64Url: "thumb-b64u",
    thumbprintHexColons: "00:00:00:00:00:00:00:00",
    createdAt: "2026-01-01T00:00:00.000Z",
    recommendedRotationAt,
  };
}

function renderPanel(overrides?: {
  setup?: Partial<AimerIntegrationSetup>;
  customerStats?: { total: number; configured: number };
  keyStatus?: AimerSigningKeyStatus;
}) {
  const setup: AimerIntegrationSetup = {
    aiceId: "aice.example.com",
    bridgeUrl: "https://aimer.example.com",
    defaultModelName: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    hasActiveSigningKey: false,
    ...(overrides?.setup ?? {}),
  };
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AimerIntegrationPanel
        initialSetup={setup}
        initialKeyStatus={overrides?.keyStatus ?? EMPTY_KEY_STATUS}
        customerStats={overrides?.customerStats ?? { total: 3, configured: 0 }}
        customers={[]}
      />
    </NextIntlClientProvider>,
  );
}

describe("AimerIntegrationPanel – customer external_key info line", () => {
  it("renders the M / N counter from the page-supplied configured / total", () => {
    renderPanel({ customerStats: { total: 5, configured: 2 } });
    const line = screen.getByTestId("aimer-customer-external-key-line");
    expect(line.textContent ?? "").toMatch(
      /Customer external_key configured:\s*2\s*\/\s*5\s*customers\./,
    );
  });

  it("renders 0 / N when no customer has external_key populated yet", () => {
    // The numerator is real (not hard-coded to 0): the page query
    // counts `external_key IS NOT NULL AND external_key <> ''`, so a
    // 0 / N reading reflects an empty rollout rather than a missing
    // schema.  This guards against a regression to the prior
    // hard-coded zero.
    renderPanel({ customerStats: { total: 5, configured: 0 } });
    const line = screen.getByTestId("aimer-customer-external-key-line");
    expect(line.textContent ?? "").toMatch(
      /Customer external_key configured:\s*0\s*\/\s*5\s*customers\./,
    );
  });
});

describe("AimerIntegrationPanel – rotation banner overdue boundary", () => {
  // Reviewer Round 3: a key that has just passed `recommendedRotationAt`
  // (even by one minute) must render the gray "overdue" banner.  The
  // prior `Math.ceil((due - now) / day)` arithmetic rounded a sub-day
  // overdue offset to `0`, so the red "within 7 days" banner showed
  // instead.  This test pins the boundary so a regression to the
  // bucket-only check would fail.
  it("renders the overdue banner when recommendedRotationAt is just minutes in the past", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    renderPanel({
      setup: { hasActiveSigningKey: true },
      keyStatus: {
        ...EMPTY_KEY_STATUS,
        state: "active_only",
        active: activeEntry(fiveMinutesAgo),
      },
    });
    expect(screen.getByText(/Rotation overdue/i)).toBeTruthy();
    expect(
      screen.queryByText(/Rotation recommended within 7 days/i),
    ).toBeNull();
  });

  it("still renders the red banner inside the 7-day window", () => {
    const inThreeDays = new Date(
      Date.now() + 3 * 24 * 60 * 60_000,
    ).toISOString();
    renderPanel({
      setup: { hasActiveSigningKey: true },
      keyStatus: {
        ...EMPTY_KEY_STATUS,
        state: "active_only",
        active: activeEntry(inThreeDays),
      },
    });
    expect(
      screen.getByText(/Rotation recommended within 7 days/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Rotation overdue/i)).toBeNull();
  });
});

describe("AimerIntegrationPanel – bridge URL save normalization", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Echo the canonical (trailing-slash-stripped) value back so
        // the panel's `setSetup` carries the normalized form.
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          value?: string;
        };
        const value = (body.value ?? "").replace(/\/+$/, "");
        return new Response(
          JSON.stringify({ data: { key: "clumit_insight_bridge_url", value } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resets the bridge URL draft to the server-normalized value after save", async () => {
    renderPanel({
      setup: { bridgeUrl: "https://aimer.example.com" },
    });

    const input = screen.getByTestId("aimer-bridge-url") as HTMLInputElement;
    expect(input.value).toBe("https://aimer.example.com");

    // Operator types an input with a trailing slash; canonical form
    // drops it.  Save button enables because the draft differs from
    // the current canonical value.
    fireEvent.change(input, {
      target: { value: "https://aimer.example.com/" },
    });
    expect(input.value).toBe("https://aimer.example.com/");

    const saveButton = screen.getByTestId(
      "aimer-bridge-url-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    // The save button opens the (non-dismissable) effect-warning
    // confirm dialog.  Click the confirm button to dispatch the
    // PATCH.
    const confirmButtons = await screen.findAllByRole("button", {
      name: /save and continue/i,
    });
    fireEvent.click(confirmButtons[0]);

    // After the PATCH resolves, the parent passes the canonical
    // value down and the SettingsBlock useEffect resyncs the draft.
    await waitFor(() => {
      expect(
        (screen.getByTestId("aimer-bridge-url") as HTMLInputElement).value,
      ).toBe("https://aimer.example.com");
    });

    // The Save button is disabled again because the draft now
    // matches the canonical value.
    await waitFor(() => {
      expect(
        (screen.getByTestId("aimer-bridge-url-save") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
});
