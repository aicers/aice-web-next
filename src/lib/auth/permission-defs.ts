/**
 * Single source of truth for all permission strings in the system.
 *
 * This module is intentionally free of `server-only` so it can be
 * imported by both server code (`permissions.ts`, `role-management.ts`)
 * and client components (`role-form-dialog.tsx`).
 *
 * Grouped by resource for display purposes (permission checkbox grid).
 */
export const ALL_PERMISSIONS = {
  accounts: ["accounts:read", "accounts:write", "accounts:delete"],
  roles: ["roles:read", "roles:write", "roles:delete"],
  customers: [
    "customers:read",
    "customers:write",
    "customers:delete",
    "customers:access-all",
  ],
  "audit-logs": ["audit-logs:read"],
  dashboard: ["dashboard:read", "dashboard:write"],
  detection: ["detection:read"],
  event: ["event:read"],
  nodes: ["nodes:read", "nodes:write", "nodes:delete"],
  services: ["services:read", "services:write"],
  "system-settings": ["system-settings:read", "system-settings:write"],
  triage: [
    "triage:read",
    "triage:policy:write",
    "triage:exclusion:write",
    "triage:exclusion:global:write",
  ],
} as const;

/** Flat set of all valid permission strings. */
export const VALID_PERMISSIONS: Set<string> = new Set(
  Object.values(ALL_PERMISSIONS).flat(),
);
