import type { Metadata } from "next";

import { appIcons, appTileMeta } from "@/lib/icons";

// The root layout is a pass-through — the locale provider/theme/font shell
// lives in `[locale]/layout.tsx`.  Declaring the brand favicons here ensures
// they also reach the root not-found boundary (`src/app/not-found.tsx`),
// which renders its own document outside the `[locale]` segment.
export const metadata: Metadata = {
  icons: appIcons,
  other: appTileMeta,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
