import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { getSystemSettings } from "@/lib/auth/system-settings";

export const GET = withAuth(
  async () => {
    const settings = await getSystemSettings();
    return NextResponse.json({ data: settings });
  },
  { requiredPermissions: ["system-settings:read"] },
);
