import { NextResponse } from "next/server";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { getAimerSigningKeyStatus } from "@/lib/aimer/signing-key";
import { withAuth } from "@/lib/auth/guard";

export const GET = withAuth(async (_request, _context, session) => {
  if (!isSystemAdministrator(session.roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getAimerSigningKeyStatus();
  return NextResponse.json({ data: status });
});
