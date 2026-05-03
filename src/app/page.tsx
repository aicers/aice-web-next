import { connection } from "next/server";

import { Logo } from "@/components/layout/logo";

export default async function Home() {
  // Opt out of static rendering so the per-request CSP nonce minted in
  // `src/proxy.ts` reaches every framework script tag.  In practice
  // next-intl rewrites `/` to `/[defaultLocale]` so this page is rarely
  // reached, but if it ever is, dynamic rendering is required for the
  // nonce flow to work — see Next.js docs:
  // https://nextjs.org/docs/app/guides/content-security-policy#static-vs-dynamic-rendering-with-csp
  await connection();

  return (
    <main className="flex min-h-screen items-center justify-center">
      <Logo className="scale-150" />
    </main>
  );
}
