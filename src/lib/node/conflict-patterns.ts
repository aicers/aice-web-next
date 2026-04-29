/**
 * Maps REview's plain-text GraphQL error messages onto typed errors that
 * the create/edit dialog and stale-conflict replay path can route to
 * specific form fields. The pattern table is documented in
 * `decisions/node-conflict-patterns.md`; the captured fixtures under
 * `src/__tests__/lib/node/fixtures/conflict-messages/` exercise each
 * row against real upstream wording.
 *
 * REview 0.47.0 does not expose typed error extensions for these
 * conflicts — they all arrive as `errors[0].message` strings — so the
 * matcher is a regex table. When REview ships typed extensions the
 * public surface here (the typed error classes + `mapConflictMessage`)
 * stays the same; only the matching rules change.
 */

export type NodeConflictField =
  | "name"
  | "hostname"
  | "customerId"
  | "service"
  | null;

export class NodeConflictError extends Error {
  /**
   * The form field the dialog should focus and show the inline error
   * under. `null` means the error is not field-scoped (e.g. stale
   * conflict, agent-not-found) and should surface at the form footer.
   */
  readonly field: NodeConflictField;

  constructor(
    message: string,
    field: NodeConflictField,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NodeConflictError";
    this.field = field;
  }
}

export class NodeNameUniqueError extends NodeConflictError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "name", options);
    this.name = "NodeNameUniqueError";
  }
}

export class NodeHostnameUniqueError extends NodeConflictError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "hostname", options);
    this.name = "NodeHostnameUniqueError";
  }
}

export class NodeCustomerScopeError extends NodeConflictError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "customerId", options);
    this.name = "NodeCustomerScopeError";
  }
}

export class NodeStaleConflictError extends NodeConflictError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, null, options);
    this.name = "NodeStaleConflictError";
  }
}

export class NodeAgentNotFoundError extends NodeConflictError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "service", options);
    this.name = "NodeAgentNotFoundError";
  }
}

interface PatternEntry {
  regex: RegExp;
  build: (message: string) => NodeConflictError;
}

const PATTERNS: readonly PatternEntry[] = [
  {
    regex: /^the node's name already exists\b/i,
    build: (m) => new NodeNameUniqueError(m),
  },
  {
    regex: /hostname .* already in use\b/i,
    build: (m) => new NodeHostnameUniqueError(m),
  },
  {
    regex: /customer .* not found\b/i,
    build: (m) => new NodeCustomerScopeError(m),
  },
  {
    regex: /no access to customer\b/i,
    build: (m) => new NodeCustomerScopeError(m),
  },
  {
    regex: /(concurrent modification|node was modified|stale)\b/i,
    build: (m) => new NodeStaleConflictError(m),
  },
  {
    regex: /agent .* not found\b/i,
    build: (m) => new NodeAgentNotFoundError(m),
  },
];

/**
 * Inspect a thrown error's GraphQL `errors[0].message` string and
 * return a typed conflict error if it matches a documented pattern.
 * Returns `null` for any unrecognised shape — the caller surfaces
 * those as a footer-level banner.
 */
export function mapConflictMessage(
  message: string | undefined | null,
): NodeConflictError | null {
  if (typeof message !== "string" || message.length === 0) return null;
  for (const entry of PATTERNS) {
    if (entry.regex.test(message)) return entry.build(message);
  }
  return null;
}

/**
 * Return the regex sources of every documented pattern, in declaration
 * order. Exposed for the fixture test suite, which asserts that each
 * captured fixture matches **exactly one** documented pattern — counting
 * raw regex hits, not the typed-error class produced by the first match.
 * Without this helper a future regex tweak that broadens one pattern and
 * silently overlaps another fixture's category would still pass the
 * `mapConflictMessage` mapping test (because that one stops at the first
 * hit).
 *
 * The return shape intentionally mirrors `PATTERNS`: each entry is
 * `(message) => boolean` so the test can run them independently against
 * a fixture string.
 */
export function patternMatchers(): readonly {
  test: (message: string) => boolean;
}[] {
  return PATTERNS.map((p) => ({ test: (m: string) => p.regex.test(m) }));
}

interface GraphQLLikeError {
  message?: unknown;
}

/**
 * Map an "agent <key> not found" upstream message back to the registry
 * service kind so the dialog can pin the inline error to the right
 * accordion section. The agent identifier in the message is the stable
 * `serviceKey` shared with `service-registry.ts`
 * (e.g. piglet → sensor, hog → semi-supervised). Returns `null` when
 * the message does not name a known agent — the dialog falls back to a
 * footer-level banner in that case.
 *
 * Kept as a string-matching helper rather than a registry import
 * because this module runs server-side under route handlers and the
 * registry pulls in React form components.
 */
const SERVICE_KIND_BY_KEY: Record<string, string> = {
  piglet: "sensor",
  giganto: "data-store",
  tivan: "ti-container",
  hog: "semi-supervised",
  crusher: "time-series",
  reconverge: "unsupervised",
};

export function serviceKindFromAgentNotFound(
  message: string | undefined | null,
): string | null {
  if (typeof message !== "string") return null;
  const match = message.match(/agent\s+([\w-]+)\s+not found/i);
  if (!match) return null;
  const key = match[1]?.toLowerCase();
  if (!key) return null;
  return SERVICE_KIND_BY_KEY[key] ?? null;
}

/**
 * Walk a thrown value (`graphql-request`'s `ClientError` shape, the
 * raw `Error.message`, or anything carrying a `response.errors[]`
 * array) and return the first typed conflict it matches. Returns
 * `null` when nothing matches.
 */
export function mapConflictError(error: unknown): NodeConflictError | null {
  if (!error || typeof error !== "object") return null;
  const direct = (error as { message?: unknown }).message;
  if (typeof direct === "string") {
    const mapped = mapConflictMessage(direct);
    if (mapped !== null) return mapped;
  }
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors) return null;
  for (const e of errors) {
    if (typeof e?.message === "string") {
      const mapped = mapConflictMessage(e.message);
      if (mapped !== null) return mapped;
    }
  }
  return null;
}

/**
 * Extract a non-empty `errors[0].message` from a `graphql-request`
 * `ClientError`-shaped value, regardless of whether it matches a
 * documented conflict pattern. Used by the route handlers to give the
 * dialog footer banner a real upstream message when REview returns a
 * new/undocumented `GraphQLError.message` instead of letting the
 * handler 500 (which would force the client into the generic
 * `errors.generic` fallback). Returns `null` for anything that does
 * not look like a GraphQL upstream error so genuine programming bugs
 * still bubble up as 500.
 */
export function extractUpstreamGraphQLMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors || errors.length === 0) return null;
  for (const e of errors) {
    if (typeof e?.message === "string" && e.message.length > 0) {
      return e.message;
    }
  }
  return null;
}
