import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  getWebAuthnCredentialById,
  removeWebAuthnCredential,
  updateWebAuthnDisplayName,
} from "@/lib/auth/webauthn";

/**
 * PATCH /api/auth/mfa/webauthn/credentials/[id]
 *
 * Rename a WebAuthn credential. Self-only (ownership verified).
 */
export const PATCH = withAuth(async (request, context, session) => {
  const { id } = await context.params;

  // Parse body
  let displayName: string;
  try {
    const body = await request.json();
    displayName = body.displayName;
    if (!displayName || typeof displayName !== "string") {
      return NextResponse.json(
        { error: "Missing required field: displayName" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Update (ownership check built into the query)
  const updated = await updateWebAuthnDisplayName(
    id,
    session.accountId,
    displayName,
  );
  if (!updated) {
    return NextResponse.json(
      { error: "Credential not found", code: "WEBAUTHN_NOT_FOUND" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true });
});

/**
 * DELETE /api/auth/mfa/webauthn/credentials/[id]
 *
 * Remove a single WebAuthn credential. Self-only (ownership verified).
 * Policy-independent — removal is always allowed.
 */
export const DELETE = withAuth(async (request, context, session) => {
  const { id } = await context.params;

  // Verify credential exists and belongs to current user
  const credential = await getWebAuthnCredentialById(id, session.accountId);
  if (!credential) {
    return NextResponse.json(
      { error: "Credential not found", code: "WEBAUTHN_NOT_FOUND" },
      { status: 404 },
    );
  }

  // Delete credential
  await removeWebAuthnCredential(id, session.accountId);

  // Audit log
  await auditLog.record({
    actor: session.accountId,
    action: "mfa.webauthn.remove",
    target: "mfa",
    targetId: session.accountId,
    ip: extractClientIp(request),
    sid: session.sessionId,
  });

  return NextResponse.json({ success: true });
});
