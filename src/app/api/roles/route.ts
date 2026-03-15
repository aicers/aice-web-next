import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import {
  createRole,
  getRoles,
  getRolesWithDetails,
} from "@/lib/auth/role-management";

/**
 * GET /api/roles
 *
 * Without `roles:read`: returns minimal fields (id, name, description,
 * is_builtin) — safe for any authenticated user (e.g. account forms).
 *
 * With `roles:read`: returns full permission arrays and account counts
 * for the role management UI.
 */
export const GET = withAuth(async (_request, _context, session) => {
  const canReadDetails = await hasPermission(session.roles, "roles:read");

  if (canReadDetails) {
    const roles = await getRolesWithDetails();
    return NextResponse.json({ data: roles });
  }

  const roles = await getRoles();
  return NextResponse.json({ data: roles });
});

/**
 * POST /api/roles
 *
 * Create a new custom role. Requires `roles:write` permission.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const name = body.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    const description =
      typeof body.description === "string" ? body.description : null;

    const permissions = body.permissions;
    if (!Array.isArray(permissions)) {
      return NextResponse.json(
        { error: "Missing required field: permissions" },
        { status: 400 },
      );
    }

    const result = await createRole(name, description, permissions as string[]);

    if (!result.valid) {
      return NextResponse.json(
        { error: "Validation failed", details: result.errors },
        { status: 400 },
      );
    }

    await auditLog.record({
      actor: session.accountId,
      action: "role.create",
      target: "role",
      targetId: String(result.data?.id),
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { name, permissions },
    });

    return NextResponse.json({ data: result.data }, { status: 201 });
  },
  { requiredPermissions: ["roles:write"] },
);
