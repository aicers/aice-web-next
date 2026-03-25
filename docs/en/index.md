# AICE Web Manual

This manual covers installation and operation of **AICE Web**
(aice-web-next), the management interface for the AICE threat
detection platform.

## What AICE Web Does

AICE Web is a full-stack Next.js application that serves as the
management interface and BFF (Backend For Frontend) for the AICE
platform. Operators use it to monitor threats, investigate events,
and manage the system. The browser never contacts the backend
directly — every GraphQL request originates from the server side of
Next.js.

Current capabilities:

- **Settings** — account, role, customer, and policy management
  with full audit logging

As the platform evolves, AICE Web will expand to cover detection
events, investigation workflows, triage, and reporting.

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
- **[Settings](settings.md)** — accounts, roles, customers,
  policies, and account status
