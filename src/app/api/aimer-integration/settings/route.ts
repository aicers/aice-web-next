import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { getAimerIntegrationSettings } from "@/lib/aimer/settings";
import { withAuth } from "@/lib/auth/guard";

export const GET = withAuth(async (_request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await getAimerIntegrationSettings();
  return NextResponse.json({ data });
});
