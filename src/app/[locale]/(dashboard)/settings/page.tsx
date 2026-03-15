import { redirect } from "next/navigation";

import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";

export default async function SettingsPage() {
  const session = await getCurrentSession();

  if (session) {
    if (await hasPermission(session.roles, "accounts:read")) {
      redirect("/settings/accounts");
    }
    if (await hasPermission(session.roles, "roles:read")) {
      redirect("/settings/roles");
    }
    if (await hasPermission(session.roles, "customers:read")) {
      redirect("/settings/customers");
    }
    if (await hasPermission(session.roles, "system-settings:read")) {
      redirect("/settings/system");
    }
  }

  // Fallback: redirect to accounts (will show permission error)
  redirect("/settings/accounts");
}
