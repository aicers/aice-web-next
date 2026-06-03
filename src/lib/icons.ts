import type { Metadata } from "next";

// The clumit brand favicons live under `public/favicon/clumit/`.  Although
// the files carry a `.ico` extension, their contents are PNG data, so each
// entry is declared with `type: "image/png"`.
//
// Shared by the locale layout (`src/app/[locale]/layout.tsx`) and the
// pass-through root layout (`src/app/layout.tsx`) so the brand icon shows
// across the whole app, including the root not-found boundary that renders
// outside the `[locale]` segment.
export const appIcons: Metadata["icons"] = {
  icon: [
    { url: "/favicon/clumit/16.ico", sizes: "16x16", type: "image/png" },
    { url: "/favicon/clumit/32.ico", sizes: "32x32", type: "image/png" },
    { url: "/favicon/clumit/96.ico", sizes: "96x96", type: "image/png" },
    { url: "/favicon/clumit/192.ico", sizes: "192x192", type: "image/png" },
  ],
  apple: [
    { url: "/favicon/clumit/57.ico", sizes: "57x57", type: "image/png" },
    { url: "/favicon/clumit/60.ico", sizes: "60x60", type: "image/png" },
    { url: "/favicon/clumit/72.ico", sizes: "72x72", type: "image/png" },
    { url: "/favicon/clumit/76.ico", sizes: "76x76", type: "image/png" },
    { url: "/favicon/clumit/114.ico", sizes: "114x114", type: "image/png" },
    { url: "/favicon/clumit/120.ico", sizes: "120x120", type: "image/png" },
    { url: "/favicon/clumit/144.ico", sizes: "144x144", type: "image/png" },
    { url: "/favicon/clumit/152.ico", sizes: "152x152", type: "image/png" },
    { url: "/favicon/clumit/180.ico", sizes: "180x180", type: "image/png" },
  ],
};
