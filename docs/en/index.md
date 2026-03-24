# AICE Web Manual

This manual covers installation, configuration, and administration of
**AICE Web** (aice-web-next), the management interface for the AICE
threat detection platform.

## What AICE Web Does

AICE Web is a full-stack Next.js application that serves as the
management interface and BFF (Backend For Frontend) for the AICE
platform. Operators use it to monitor threats, investigate events,
and manage the system. The browser never contacts the backend
directly — every GraphQL request originates from the server side of
Next.js.

Current capabilities:

- **Administration** — account, role, customer, and system settings
  management with full audit logging
- **Dashboard** — real-time operational overview for administrators

As the platform evolves, AICE Web will expand to cover event
investigation, detection rule management, triage workflows, and
reporting.

## Architecture Overview

```text
Browser ──► Next.js (aice-web-next) ──► review-web (GraphQL)
              │         │                    │
              │         └─► auth_db (PG)     ├─ mTLS handshake
              │                              ├─ Context JWT verification
              ├─ Route Handlers              └─ RoleGuard + CustomerIds
              ├─ Server Actions
              └─ React Server Components
```

AICE Web manages its own authentication database (`auth_db`) and a
separate audit database (`audit_db`). Customer-specific runtime
databases are provisioned and migrated automatically.

## Role System

| Role | Scope |
|------|-------|
| System Administrator | Full system, account, role, customer management |
| Tenant Administrator | Tenant-scoped operations + Security Monitor account management |
| Security Monitor | Read-only event and dashboard access within assigned customers |
| Custom Role | Administrator-defined permission combinations |

## Manual Map

- **[Getting Started](getting-started.md)** — prerequisites,
  installation, and first sign-in
- **[Configuration](configuration.md)** — environment variables,
  databases, mTLS, and Nginx
- **[Administration](administration.md)** — accounts, roles,
  customers, system settings, and audit logs
