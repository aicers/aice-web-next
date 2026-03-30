import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { verifyPassword } from "@/lib/auth/password";
import {
  getWebAuthnCredentialById,
  removeWebAuthnCredential,
  updateWebAuthnDisplayName,
} from "@/lib/auth/webauthn";
import { query } from "@/lib/db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/auth/mfa/webauthn/credentials/[id]
 *
 * Rename a WebAuthn credential. Self-only (ownership verified).
 */
export const PATCH = withAuth(async (request, context, session) => {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid credential ID" },
      { status: 400 },
    );
  }

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
 * Requires password confirmation to prevent session-hijack downgrade.
 * Policy-independent — removal is always allowed.
 */
export const DELETE = withAuth(async (request, context, session) => {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid credential ID" },
      { status: 400 },
    );
  }

  // Step 1: Parse body — requires password
  let password: string;
  try {
    const body = await request.json();
    password = body.password;
  } catch {
    // empty body or malformed JSON
    password = "";
  }
  if (!password || typeof password !== "string") {
    return NextResponse.json(
      {
        error: "Missing required field: password",
        code: "PASSWORD_REQUIRED",
      },
      { status: 400 },
    );
  }

  // Step 2: Verify password
  const { rows: accountRows } = await query<{ password_hash: string }>(
    "SELECT password_hash FROM accounts WHERE id = $1",
    [session.accountId],
  );
  if (accountRows.length === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!(await verifyPassword(accountRows[0].password_hash, password))) {
    return NextResponse.json(
      { error: "Invalid password", code: "INVALID_PASSWORD" },
      { status: 401 },
    );
  }

  // Step 3: Verify credential exists and belongs to current user
  const credential = await getWebAuthnCredentialById(id, session.accountId);
  if (!credential) {
    return NextResponse.json(
      { error: "Credential not found", code: "WEBAUTHN_NOT_FOUND" },
      { status: 404 },
    );
  }

  // Step 4: Delete credential
  await removeWebAuthnCredential(id, session.accountId);

  // Step 5: Audit log
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
