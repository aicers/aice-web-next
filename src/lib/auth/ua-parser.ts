import "server-only";

/**
 * Browser detection patterns, ordered by specificity.
 *
 * Edge must precede Chrome because Edge UAs include "Chrome/".
 * OPR (Opera) must also precede Chrome for the same reason.
 */
const BROWSER_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "Edge", regex: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: "Opera", regex: /OPR\/(\d+)/ },
  { name: "Chrome", regex: /Chrome\/(\d+)/ },
  { name: "Firefox", regex: /Firefox\/(\d+)/ },
  { name: "Safari", regex: /Version\/(\d+).*Safari/ },
];

/**
 * Extract a normalized browser fingerprint from a User-Agent string.
 *
 * Returns `"Family/MajorVersion"` (e.g. `"Chrome/131"`, `"Firefox/133"`,
 * `"Safari/17"`).  Returns `"Unknown/0"` for unrecognizable UAs.
 */
export function extractBrowserFingerprint(userAgent: string): string {
  if (!userAgent) return "Unknown/0";

  for (const { name, regex } of BROWSER_PATTERNS) {
    const match = regex.exec(userAgent);
    if (match) {
      return `${name}/${match[1]}`;
    }
  }

  return "Unknown/0";
}

/**
 * Compare two browser fingerprints.
 *
 * - `"same"`:  identical family and major version
 * - `"minor"`: same family, different major version (e.g. auto-update)
 * - `"major"`: different family entirely
 */
export function compareBrowserFingerprints(
  stored: string,
  current: string,
): "same" | "minor" | "major" {
  if (stored === current) return "same";

  const [storedFamily] = stored.split("/");
  const [currentFamily] = current.split("/");

  if (storedFamily === currentFamily) return "minor";

  return "major";
}
