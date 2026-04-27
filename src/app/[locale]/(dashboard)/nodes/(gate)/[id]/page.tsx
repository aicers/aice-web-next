import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getCurrentSession } from "@/lib/auth/session";

// Phase Node-6 (this PR) makes the Status row navigational: clicking
// a row pushes `/nodes/[id]`. The full per-node detail dashboard and
// the "Apply All Pending" affordance are owned by Phase Node-5, so
// this placeholder is intentionally minimal — it exists to give the
// row navigation a real destination (instead of the framework 404)
// and a stable testid hook (`node-detail-placeholder`) that Phase
// Node-5 can replace in-place when it lands the real dashboard.
//
// The combined `nodes:read + services:read` gate is enforced in the
// parent `(gate)/layout.tsx`, so missing permissions still surface a
// real HTTP 403 with the localised forbidden panel. The placeholder
// deliberately does NOT fetch the node from the manager: tenant-scope
// enforcement on the detail surface is part of the Phase Node-5 data
// contract, and pulling in a NodeDetail GraphQL fixture for a
// throwaway placeholder would cement a fixture shape that Phase
// Node-5 has not yet ratified.
export default async function NodeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const t = await getTranslations("nodes.detail");

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-6"
      data-testid="node-detail-placeholder"
      data-node-id={id}
    >
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm font-mono">{id}</p>
      </header>
      <p className="text-muted-foreground text-sm">{t("placeholder")}</p>
    </section>
  );
}
