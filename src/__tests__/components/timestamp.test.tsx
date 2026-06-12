/**
 * Unit coverage for the centralized timestamp API (RFC 0004 / #764):
 * the `<Timestamp>` component and the `useTimestampFormatter` hook.
 *
 * The two phases are exercised separately:
 *  - Pre-mount (server render / first client paint) is captured with
 *    `renderToStaticMarkup`, where the mount effect never fires, so the
 *    deterministic placeholder is what ships in SSR HTML.
 *  - Post-mount is exercised with React Testing Library, where the
 *    effect flushes and the resolved value replaces the placeholder.
 *
 * `useTimezone` and `useLocale` are mocked to fixed values so the
 * formatted output is deterministic regardless of the runtime timezone
 * and the test never needs a real `TimezoneProvider` /
 * `NextIntlClientProvider`.
 */

import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const TZ = "Asia/Seoul";
const localeRef = vi.hoisted(() => ({ current: "en" }));

// Default (unset) resolved format — byte-identical to the no-options
// formatter output the assertions compare against. A stable reference
// (the real provider memoizes it) so formatter identities stay stable
// across re-renders.
const resolvedTimeFormatRef = vi.hoisted(() => ({
  current: {
    locale: undefined,
    hourCycle: undefined,
    seconds: true,
    tzLabel: false,
  },
}));

vi.mock("@/components/providers/account-preferences-provider", () => ({
  useTimezone: () => "Asia/Seoul",
  useResolvedTimeFormat: () => resolvedTimeFormatRef.current,
}));
vi.mock("next-intl", () => ({
  useLocale: () => localeRef.current,
}));

import {
  TIMESTAMP_RESERVED_CH,
  Timestamp,
  useTimestampFormatter,
} from "@/components/timestamp";
import { formatDateTime, formatDateTimeCompact } from "@/lib/format-date";

const ISO = "2026-04-22T15:30:45.000Z";

/**
 * Approximate the rendered column width of a string: CJK / Hangul
 * glyphs occupy ~2 monospace cells, everything else ~1. Mirrors the
 * budgeting the reserved-width constants are sized against.
 */
function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
  }
  return width;
}

describe("<Timestamp> — pre-mount placeholder (SSR / first paint)", () => {
  it("renders a deterministic, layout-stable, non-announced placeholder", () => {
    const html = renderToStaticMarkup(<Timestamp at={ISO} />);
    // Busy + hidden so assistive tech does not announce the placeholder.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("visibility:hidden");
    // Fixed footprint reserved for the resolved value (no layout shift).
    expect(html).toContain("inline-block");
    expect(html).toContain(`min-width:${TIMESTAMP_RESERVED_CH.general}ch`);
    // Machine-readable instant present in both phases.
    expect(html).toContain(`dateTime="${ISO}"`);
    // No timezone/locale-dependent value is ever painted pre-mount.
    expect(html).not.toContain(formatDateTime(ISO, TZ));
  });

  it("reserves the compact width for the compact variant", () => {
    const html = renderToStaticMarkup(<Timestamp at={ISO} compact />);
    expect(html).toContain(`min-width:${TIMESTAMP_RESERVED_CH.compact}ch`);
  });

  it("is byte-identical across renders (no per-render nondeterminism)", () => {
    expect(renderToStaticMarkup(<Timestamp at={ISO} />)).toBe(
      renderToStaticMarkup(<Timestamp at={ISO} />),
    );
  });
});

describe("<Timestamp> — post-mount resolved value", () => {
  it("renders the value in the provider timezone as a semantic <time>", async () => {
    render(<Timestamp at={ISO} />);
    const el = await screen.findByText(formatDateTime(ISO, TZ));
    expect(el.tagName).toBe("TIME");
    // dateTime carries the raw ISO instant in the resolved phase too.
    expect(el.getAttribute("dateTime")).toBe(ISO);
    // The placeholder is gone — no lingering aria-busy.
    expect(el.getAttribute("aria-busy")).toBeNull();
  });

  it("renders the compact form using the active locale", async () => {
    localeRef.current = "ko";
    try {
      render(<Timestamp at={ISO} compact />);
      await screen.findByText(formatDateTimeCompact(ISO, TZ, "ko"));
    } finally {
      localeRef.current = "en";
    }
  });

  it("accepts a Date and exposes its ISO instant in dateTime", async () => {
    render(<Timestamp at={new Date(ISO)} />);
    const el = await screen.findByText(formatDateTime(ISO, TZ));
    expect(el.getAttribute("dateTime")).toBe(ISO);
  });
});

describe("useTimestampFormatter", () => {
  it("returns null formatters pre-mount (resolved === false)", () => {
    function Probe() {
      const { resolved, format, formatCompact } = useTimestampFormatter();
      return <span>{`${resolved}|${format(ISO)}|${formatCompact(ISO)}`}</span>;
    }
    // SSR render — the mount effect never fires.
    expect(renderToStaticMarkup(<Probe />)).toContain("false|null|null");
  });

  it("formats in the provider timezone post-mount", async () => {
    const { result } = renderHook(() => useTimestampFormatter());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.format(ISO)).toBe(formatDateTime(ISO, TZ));
  });

  it("formatCompact honours the active locale", async () => {
    localeRef.current = "ko";
    try {
      const { result } = renderHook(() => useTimestampFormatter());
      await waitFor(() => expect(result.current.resolved).toBe(true));
      expect(result.current.formatCompact(ISO)).toBe(
        formatDateTimeCompact(ISO, TZ, "ko"),
      );
    } finally {
      localeRef.current = "en";
    }
  });

  it("keeps stable formatter identities across re-renders", async () => {
    const { result, rerender } = renderHook(() => useTimestampFormatter());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    const first = result.current.format;
    rerender();
    expect(result.current.format).toBe(first);
  });
});

describe("reserved-width pin", () => {
  // Worst case: every field two digits, a PM hour, in a zone that does
  // not shrink any field. If a future edit shaves the reservation below
  // the real worst-case output width, these assertions fail.
  const WORST = new Date("2026-12-30T23:59:59Z");

  function generalWidth(locale: string): number {
    return visualWidth(
      WORST.toLocaleString(locale, {
        timeZone: "UTC",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }),
    );
  }

  function compactWidth(locale: string): number {
    return visualWidth(
      WORST.toLocaleString(locale, {
        timeZone: "UTC",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  }

  it("reserves enough general width for en and ko worst cases", () => {
    expect(TIMESTAMP_RESERVED_CH.general).toBeGreaterThanOrEqual(
      generalWidth("en-US"),
    );
    expect(TIMESTAMP_RESERVED_CH.general).toBeGreaterThanOrEqual(
      generalWidth("ko"),
    );
  });

  it("reserves enough compact width for en and ko worst cases", () => {
    expect(TIMESTAMP_RESERVED_CH.compact).toBeGreaterThanOrEqual(
      compactWidth("en-US"),
    );
    expect(TIMESTAMP_RESERVED_CH.compact).toBeGreaterThanOrEqual(
      compactWidth("ko"),
    );
  });
});
