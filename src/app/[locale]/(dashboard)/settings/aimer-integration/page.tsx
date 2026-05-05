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

  const [setup, keyStatus, customerStats] = await Promise.all([
    getAimerIntegrationSetup(),
    getAimerSigningKeyStatus(),
    loadCustomerStats(),
  ]);

  return (
    <AimerIntegrationPanel
      initialSetup={setup}
      initialKeyStatus={keyStatus}
      customerStats={customerStats}
    />
  );
}

async function loadCustomerStats(): Promise<{
  total: number;
  configured: number | null;
}> {
  // The per-customer `external_key` column is introduced by
  // Sub-7.2.E (#440); until it lands we cannot compute the
  // numerator and intentionally surface `configured = null` so the
  // UI shows the total alone instead of a misleading `0 / N`.
  const { rows: colRows } = await query<{ has: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'customers'
         AND column_name = 'external_key'
     ) AS has`,
  );
  const hasExternalKey = colRows[0]?.has ?? false;

  const totalRes = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM customers WHERE status = 'active'",
  );
  const total = Number(totalRes.rows[0]?.count ?? "0");

  let configured: number | null = null;
  if (hasExternalKey) {
    const configuredRes = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM customers
        WHERE status = 'active'
          AND external_key IS NOT NULL
          AND external_key <> ''`,
    );
    configured = Number(configuredRes.rows[0]?.count ?? "0");
    if (!Number.isFinite(configured)) configured = 0;
  }

  return {
    total: Number.isFinite(total) ? total : 0,
    configured,
  };
}
