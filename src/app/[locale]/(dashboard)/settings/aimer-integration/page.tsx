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

async function loadCustomerStats(): Promise<{ total: number }> {
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM customers WHERE status = 'active'",
  );
  const total = Number(rows[0]?.count ?? "0");
  return { total: Number.isFinite(total) ? total : 0 };
}
