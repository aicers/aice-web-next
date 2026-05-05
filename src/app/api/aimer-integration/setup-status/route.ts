import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { getAimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";
import { withAuth } from "@/lib/auth/guard";

export const GET = withAuth(async (_request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await getAimerIntegrationSetupStatus();
  return NextResponse.json({ data });
});
