import "server-only";

import { parseExpectedOrigin } from "@/lib/auth/csrf";

/**
 * Runtime marker the prod compose profile sets to opt-in to the
 * boot-time environment guards in this module. Keyed off this
 * marker, not `NODE_ENV` alone, so non-compose production
 * deployments (K8s, smoke-tests, custom images) are not subjected
 * to checks that assume the compose-network topology.
 */
export const PROD_COMPOSE_PROFILE_MARKER = "prod-compose";
export const PROD_COMPOSE_ENV_VAR = "AICE_ENV_PROFILE";

/**
 * Central registry of PostgreSQL DSN env vars. Adding a new
 * connection setting requires extending this list so the
 * localhost-in-container guard cannot be bypassed accidentally.
 */
export const POSTGRES_DSN_ENV_VARS: readonly string[] = [
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "AUDIT_DATABASE_URL",
];

const CONTAINER_LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  // URL parsing wraps IPv6 hosts in brackets — match that shape too.
  "[::1]",
]);

export function isProdComposeProfile(): boolean {
  return (
    process.env[PROD_COMPOSE_ENV_VAR]?.trim() === PROD_COMPOSE_PROFILE_MARKER
  );
}

interface DsnHostnameIssue {
  envVar: string;
  hostname: string;
}

/**
 * Extract the hostname from a PostgreSQL DSN. Returns `null` when
 * the value is unset, blank, or unparseable — neither case is the
 * concern of this module (other code paths surface unparseable
 * DSNs as connection-time failures).
 */
function dsnHostname(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    // `url.hostname` for IPv6 strips the brackets; normalise to
    // lowercase so the membership check is case-insensitive.
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function findContainerLocalDsnHostnames(
  env: NodeJS.ProcessEnv = process.env,
): DsnHostnameIssue[] {
  const issues: DsnHostnameIssue[] = [];
  for (const envVar of POSTGRES_DSN_ENV_VARS) {
    const hostname = dsnHostname(env[envVar]);
    if (hostname === null) continue;
    // `URL.hostname` strips IPv6 brackets, so check the bare form
    // (`::1`) and the bracketed form for completeness.
    if (
      CONTAINER_LOCAL_HOSTS.has(hostname) ||
      CONTAINER_LOCAL_HOSTS.has(`[${hostname}]`)
    ) {
      issues.push({ envVar, hostname });
    }
  }
  return issues;
}

/**
 * Validate the prod compose environment before the app starts
 * serving traffic. Throws with a single aggregated error listing
 * every problem found so the operator gets the full picture in one
 * boot log instead of fix-restart-discover-next-problem cycles.
 *
 * No-op when {@link isProdComposeProfile} returns `false`.
 */
export function validateProdComposeEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[PROD_COMPOSE_ENV_VAR]?.trim() !== PROD_COMPOSE_PROFILE_MARKER) {
    return;
  }

  const problems: string[] = [];

  // EXPECTED_ORIGIN: required, must be a strict origin (scheme +
  // host + optional port only).
  const rawOrigin = env.EXPECTED_ORIGIN?.trim() ?? "";
  if (rawOrigin.length === 0) {
    problems.push(
      "EXPECTED_ORIGIN is required on the prod compose path (AICE_ENV_PROFILE=" +
        `${PROD_COMPOSE_PROFILE_MARKER}) so the CSRF/Origin guard pins ` +
        "authenticated mutations to the public HTTPS origin. Set it to the " +
        "public origin the browser sees, e.g. `https://your.public.host:9443`.",
    );
  } else if (parseExpectedOrigin(rawOrigin) === null) {
    problems.push(
      `EXPECTED_ORIGIN=${JSON.stringify(rawOrigin)} is not a valid origin. ` +
        "It must be an exact origin: scheme + host + optional port only, " +
        "with no path, query, or fragment (e.g. `https://your.public.host:9443`).",
    );
  }

  // PostgreSQL DSN hostnames: container-local addresses are not
  // reachable from inside the `next-app` container.
  const dsnIssues = findContainerLocalDsnHostnames(env);
  for (const { envVar, hostname } of dsnIssues) {
    problems.push(
      `${envVar} points at \`${hostname}\`, which is a container-local ` +
        "address from inside the `next-app` container — it cannot reach the " +
        "compose `postgres` service. Use the compose-network hostname " +
        "`postgres:5432` instead (see `.env.example.prod`).",
    );
  }

  if (problems.length === 0) return;

  const bullets = problems.map((p) => `  - ${p}`).join("\n");
  throw new Error(
    "Prod compose environment validation failed. Fix the following before " +
      "the next boot:\n" +
      bullets +
      '\n\nSee `.env.example.prod` and README → "First-boot deployment ' +
      'checklist" for the expected shape.',
  );
}
