# AICE Web Manual

This manual explains how to install, configure, and use **AICE Web**
(aice-web-next), a full-stack web application built with Next.js that serves
the browser UI and acts as a BFF (Backend For Frontend) for review-web.

## What AICE Web Does

AICE Web provides a web-based management interface for the AICE platform.
It mediates all communication between the browser and review-web (the GraphQL
backend). The browser never accesses review-web directly — every GraphQL
request originates from the server side of Next.js.

Key capabilities:

- **Account management**: Sign-in, sign-out, password management, and
  role-based access control
- **Customer management**: Multi-tenant customer lifecycle management
- **Dashboard**: Real-time monitoring and visualization
- **Audit logging**: Comprehensive audit trail for all operations
- **Settings**: System and user preference configuration

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

## Role System

| Role | Scope |
|------|-------|
| System Administrator | Full system, account, role, customer management |
| Tenant Administrator | Tenant-scoped ops + Security Monitor account management |
| Security Monitor | Event/dashboard read-only within assigned customer |
| Custom Role | System Administrator-defined permission combinations |

## Manual Map

- **Getting Started**: Prerequisites, installation, and first launch
- **Configuration**: Environment variables, database setup, mTLS certificates,
  and Nginx reverse proxy
- **Usage**: Sign-in, account management, customer management, dashboard,
  audit logs, and settings
