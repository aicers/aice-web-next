import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLastDetectionUrl,
  LAST_URL_MAX_AGE_MS,
  lastDetectionUrlKey,
  parseLastDetectionUrl,
  readLastDetectionUrl,
  resolveDetectionReturnHref,
  serializeLastDetectionUrl,
  writeLastDetectionUrl,
} from "@/lib/detection/last-detection-url";

const FP_A = "fingerprint-account-a";
const FP_B = "fingerprint-account-b";
const NOW = 1_750_000_000_000;
const SEARCH = "f=abc123&tab=tab-1";

describe("serializeLastDetectionUrl / parseLastDetectionUrl", () => {
  it("round-trips a query string", () => {
    const raw = serializeLastDetectionUrl(SEARCH, NOW);
    expect(parseLastDetectionUrl(raw, NOW)).toBe(SEARCH);
  });

  it("returns null for null / empty input", () => {
    expect(parseLastDetectionUrl(null, NOW)).toBeNull();
    expect(parseLastDetectionUrl("", NOW)).toBeNull();
  });

  it("returns null for non-JSON", () => {
    expect(parseLastDetectionUrl("not-json", NOW)).toBeNull();
  });

  it("returns null on a mismatched version", () => {
    const bad = JSON.stringify({ version: 99, search: SEARCH, savedAt: NOW });
    expect(parseLastDetectionUrl(bad, NOW)).toBeNull();
  });

  it("returns null on a missing / non-string search", () => {
    const bad = JSON.stringify({ version: 1, savedAt: NOW });
    expect(parseLastDetectionUrl(bad, NOW)).toBeNull();
    const bad2 = JSON.stringify({ version: 1, search: 42, savedAt: NOW });
    expect(parseLastDetectionUrl(bad2, NOW)).toBeNull();
  });

  it("returns null on an empty search string", () => {
    const raw = serializeLastDetectionUrl("", NOW);
    expect(parseLastDetectionUrl(raw, NOW)).toBeNull();
  });

  it("returns null on an oversized search string", () => {
    const raw = serializeLastDetectionUrl("x".repeat(9000), NOW);
    expect(parseLastDetectionUrl(raw, NOW)).toBeNull();
  });

  it("returns null when the stored value is expired", () => {
    const raw = serializeLastDetectionUrl(SEARCH, NOW);
    expect(
      parseLastDetectionUrl(raw, NOW + LAST_URL_MAX_AGE_MS + 1),
    ).toBeNull();
    // Just inside the window still resolves.
    expect(parseLastDetectionUrl(raw, NOW + LAST_URL_MAX_AGE_MS)).toBe(SEARCH);
  });

  it("returns null on a missing / non-numeric savedAt", () => {
    const bad = JSON.stringify({ version: 1, search: SEARCH });
    expect(parseLastDetectionUrl(bad, NOW)).toBeNull();
    const bad2 = JSON.stringify({
      version: 1,
      search: SEARCH,
      savedAt: "soon",
    });
    expect(parseLastDetectionUrl(bad2, NOW)).toBeNull();
  });
});

describe("sessionStorage integration", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { sessionStorage: createMemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads back what was written under the per-fingerprint key", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    const key = lastDetectionUrlKey(FP_A);
    expect(key).not.toBeNull();
    expect(readLastDetectionUrl(FP_A, NOW)).toBe(SEARCH);
  });

  it("isolates payloads across fingerprints (account A vs B in same tab)", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    expect(readLastDetectionUrl(FP_A, NOW)).toBe(SEARCH);
    // A different scope must NOT inherit account A's restored URL.
    expect(readLastDetectionUrl(FP_B, NOW)).toBeNull();
  });

  it("treats a null fingerprint as a no-op (no provider context)", () => {
    expect(() => writeLastDetectionUrl(SEARCH, null, NOW)).not.toThrow();
    expect(readLastDetectionUrl(null, NOW)).toBeNull();
    expect(() => clearLastDetectionUrl(null)).not.toThrow();
  });

  it("swallows writes that would throw (quota / privacy mode)", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        getItem: () => null,
        removeItem: () => {},
      },
    });
    expect(() => writeLastDetectionUrl(SEARCH, FP_A, NOW)).not.toThrow();
  });

  it("clearLastDetectionUrl removes the payload", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    clearLastDetectionUrl(FP_A);
    expect(readLastDetectionUrl(FP_A, NOW)).toBeNull();
  });

  it("returns null on a read when no payload is present", () => {
    expect(readLastDetectionUrl(FP_A, NOW)).toBeNull();
  });
});

describe("resolveDetectionReturnHref", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { sessionStorage: createMemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds /detection?<search> when a stored URL exists", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    expect(resolveDetectionReturnHref(FP_A, NOW)).toBe(`/detection?${SEARCH}`);
  });

  it("returns null (bare route fallback) when nothing is stored", () => {
    expect(resolveDetectionReturnHref(FP_A, NOW)).toBeNull();
  });

  it("returns null (bare route fallback) when the stored URL is expired", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    expect(
      resolveDetectionReturnHref(FP_A, NOW + LAST_URL_MAX_AGE_MS + 1),
    ).toBeNull();
  });

  it("returns null for a different scope (no cross-scope leak)", () => {
    writeLastDetectionUrl(SEARCH, FP_A, NOW);
    expect(resolveDetectionReturnHref(FP_B, NOW)).toBeNull();
  });
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}
