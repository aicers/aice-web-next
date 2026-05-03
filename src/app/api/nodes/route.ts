import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import {
  extractUpstreamGraphQLMessage,
  mapConflictError,
  serviceKindFromAgentNotFound,
} from "@/lib/node/conflict-patterns";
import { createNodeWithAudit } from "@/lib/node/node-create-update";
import {
  ManagerUnavailableError,
  NodePermissionError,
} from "@/lib/node/server-actions";
import type { AgentDraftInput, ExternalServiceInput } from "@/lib/node/types";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
} from "@/lib/review/errors";

interface CreateNodeBody {
  name: string;
  customerId: string;
  description: string;
  hostname: string;
  agents: AgentDraftInput[];
  externalServices: ExternalServiceInput[];
}

interface ConflictResponse {
  error: string;
  field: string | null;
  serviceKind?: string;
}

/**
 * POST /api/nodes
 *
 * Create a new node and emit `node.create` (plus any `service.set_mode`
 * audits derived server-side from the persisted agent state). Requires
 * both `nodes:write` and `services:write` — partial-permission callers
 * cannot reach this route. Server-reported conflicts (name / hostname
 * uniqueness, customer scope, etc.) are mapped through
 * `mapConflictError` so the dialog can focus the offending field;
 * unmatched upstream errors fall through to a 500.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    let body: CreateNodeBody;
    try {
      body = (await request.json()) as CreateNodeBody;
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    if (
      typeof body.name !== "string" ||
      typeof body.customerId !== "string" ||
      typeof body.hostname !== "string" ||
      !Array.isArray(body.agents) ||
      !Array.isArray(body.externalServices)
    ) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    try {
      const id = await createNodeWithAudit(
        session,
        {
          name: body.name,
          customerId: body.customerId,
          description: body.description ?? "",
          hostname: body.hostname,
          agents: body.agents,
          externalServices: body.externalServices,
        },
        { ip: extractClientIp(request) },
      );
      return NextResponse.json({ id });
    } catch (err) {
      const conflict = mapConflictError(err);
      if (conflict) {
        const payload: ConflictResponse = {
          error: conflict.message,
          field: conflict.field,
        };
        if (conflict.field === "service") {
          const serviceKind = serviceKindFromAgentNotFound(conflict.message);
          if (serviceKind) payload.serviceKind = serviceKind;
        }
        return NextResponse.json(payload, { status: 409 });
      }
      if (
        err instanceof NodePermissionError ||
        err instanceof ReviewForbiddenError
      ) {
        // BFF or review-side permission denial both surface as 403
        // so the dialog focuses the operator on the access affordance
        // rather than the generic 500 fallback. (#405 I)
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (err instanceof ReviewInvalidArgumentError) {
        return NextResponse.json(
          { error: "Invalid argument" },
          { status: 400 },
        );
      }
      if (err instanceof ManagerUnavailableError) {
        return NextResponse.json(
          { error: "Manager unavailable" },
          { status: 503 },
        );
      }
      // Unmatched but GraphQL-shaped upstream errors fall through to a
      // structured 502 so the dialog footer banner can show the real
      // REview message instead of the generic 500 fallback. The body
      // shape (`field: null`) routes the dialog to `setSubmitError`
      // rather than the stale-conflict prompt (which is reserved for
      // 409 + `field: null`). Anything that does not look like a
      // GraphQLError still bubbles as a real 500 so genuine programming
      // bugs are not papered over.
      const upstream = extractUpstreamGraphQLMessage(err);
      if (upstream !== null) {
        const payload: ConflictResponse = { error: upstream, field: null };
        return NextResponse.json(payload, { status: 502 });
      }
      throw err;
    }
  },
  { requiredPermissions: ["nodes:write", "services:write"] },
);
