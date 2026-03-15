import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { deleteRole, updateRole } from "@/lib/auth/role-management";

/**
 * PATCH /api/roles/[id]
 *
 * Update a custom role. Requires `roles:write` permission.
 * Built-in roles cannot be modified.
 */
export const PATCH = withAuth(
  async (request, context, session) => {
    const { id: idStr } = await context.params;
    const id = Number(idStr);
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: "Invalid role ID" }, { status: 400 });
    }

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

    const result = await updateRole(
      id,
      name,
      description,
      permissions as string[],
    );

    if (!result.valid) {
      const status = result.errors?.some(
        (e) =>
          e === "Role not found" || e === "Built-in roles cannot be modified",
      )
        ? 403
        : 400;
      return NextResponse.json(
        { error: result.errors?.[0], details: result.errors },
        { status },
      );
    }

    await auditLog.record({
      actor: session.accountId,
      action: "role.update",
      target: "role",
      targetId: idStr,
      ip: extractClientIp(request),
      sid: session.sessionId,
      details: { name, permissions },
    });

    return NextResponse.json({ data: result.data });
  },
  { requiredPermissions: ["roles:write"] },
);

/**
 * DELETE /api/roles/[id]
 *
 * Delete a custom role. Requires `roles:delete` permission.
 * Built-in roles and roles in use cannot be deleted.
 */
export const DELETE = withAuth(
  async (request, context, session) => {
    const { id: idStr } = await context.params;
    const id = Number(idStr);
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: "Invalid role ID" }, { status: 400 });
    }

    const result = await deleteRole(id);

    if (!result.valid) {
      const status = result.errors?.some(
        (e) =>
          e === "Role not found" || e === "Built-in roles cannot be deleted",
      )
        ? 403
        : 400;
      return NextResponse.json(
        { error: result.errors?.[0], details: result.errors },
        { status },
      );
    }

    await auditLog.record({
      actor: session.accountId,
      action: "role.delete",
      target: "role",
      targetId: idStr,
      ip: extractClientIp(request),
      sid: session.sessionId,
    });

    return NextResponse.json({ success: true });
  },
  { requiredPermissions: ["roles:delete"] },
);
