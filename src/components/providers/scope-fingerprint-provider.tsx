"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Per-session stable scope fingerprint (see
 * `src/lib/auth/scope-fingerprint.ts`). The fingerprint is computed
 * server-side once per request from the resolved customer scope and
 * injected here so every client-side cache owner reads the same value
 * through one channel.
 *
 * `null` means the dashboard tree was rendered without a fingerprint
 * (sign-out path that still passes through layout-rendered children,
 * tests, storybook). Consumers must treat `null` as "no fingerprint
 * available" and fall back to a non-cached path rather than reusing
 * a previous scope's payload.
 */
interface ScopeFingerprintContextValue {
  fingerprint: string | null;
}

const ScopeFingerprintContext = createContext<ScopeFingerprintContextValue>({
  fingerprint: null,
});

export function useScopeFingerprint(): string | null {
  return useContext(ScopeFingerprintContext).fingerprint;
}

export function ScopeFingerprintProvider({
  fingerprint,
  children,
}: {
  fingerprint: string | null;
  children: ReactNode;
}) {
  return (
    <ScopeFingerprintContext.Provider value={{ fingerprint }}>
      {children}
    </ScopeFingerprintContext.Provider>
  );
}
