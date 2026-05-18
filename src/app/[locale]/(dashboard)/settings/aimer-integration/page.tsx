import { redirect } from "next/navigation";

import { AimerIntegrationPanel } from "@/components/settings/aimer-integration-panel";
import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { getAimerSigningKeyStatus } from "@/lib/aimer/signing-key";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";

export default async function AimerIntegrationSettingsPage() {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/");
  }
  if (!isSystemAdministrator(session.roles)) {
    redirect("/");
  }

  const [setup, keyStatus, customerStats, customers] = await Promise.all([
    getAimerIntegrationSetup(),
    getAimerSigningKeyStatus(),
    loadCustomerStats(),
    loadActiveCustomers(),
  ]);

  return (
    <AimerIntegrationPanel
      initialSetup={setup}
      initialKeyStatus={keyStatus}
      customerStats={customerStats}
      customers={customers}
    />
  );
}

async function loadActiveCustomers(): Promise<{ id: number; name: string }[]> {
  // System Administrator inherits `customers:access-all` so the page
  // surfaces every active customer for the Phase 2 status / sync-now /
  // backfill picker; the wrapper routes re-validate scope per request.
  const { rows } = await query<{ id: number; name: string }>(
    `SELECT id, name
       FROM customers
      WHERE status = 'active'
      ORDER BY name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

async function loadCustomerStats(): Promise<{
  total: number;
  configured: number;
}> {
  const { rows } = await query<{ total: string; configured: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::text AS total,
       COUNT(*) FILTER (
         WHERE status = 'active'
           AND external_key IS NOT NULL
           AND external_key <> ''
       )::text AS configured
       FROM customers`,
  );
  const total = Number(rows[0]?.total ?? "0");
  const configured = Number(rows[0]?.configured ?? "0");
  return {
    total: Number.isFinite(total) ? total : 0,
    configured: Number.isFinite(configured) ? configured : 0,
  };
}
