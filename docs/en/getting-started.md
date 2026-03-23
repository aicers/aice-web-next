# Getting Started

This page covers prerequisites, installation, and first sign-in.

## Prerequisites

| Component | Version |
|-----------|---------|
| Node.js | 24 or later |
| PostgreSQL | 15 or later |
| pnpm | 9 or later |

Two PostgreSQL databases are required:

- **auth_db** — stores accounts, roles, sessions, customers, and
  system settings.
- **audit_db** — stores immutable audit log records. Uses a
  restricted database role (`INSERT`/`SELECT` only) for tamper
  resistance.

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/aicers/aice-web-next.git
cd aice-web-next
pnpm install
```

Copy the example environment file and fill in the values (see
[Configuration](configuration.md) for details):

```bash
cp .env.example .env.local
```

Build the application:

```bash
pnpm build
```

## Database Setup

Create the two databases and an audit-specific role:

```sql
CREATE DATABASE auth_db;
CREATE DATABASE audit_db;

-- audit_db writer role (INSERT/SELECT only)
CREATE ROLE audit_writer WITH LOGIN PASSWORD 'changeme';
GRANT CONNECT ON DATABASE audit_db TO audit_writer;
-- After connecting to audit_db:
GRANT USAGE ON SCHEMA public TO audit_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO audit_writer;
```

Migrations run automatically on startup. No manual migration step
is needed.

## Initial Admin Account

On first startup, AICE Web creates a System Administrator account
if the `accounts` table is empty. Credentials are read from one of
two sources (checked in order):

1. **Docker secret files** (recommended for production):
    - `/run/secrets/init_admin_username`
    - `/run/secrets/init_admin_password`
2. **Environment variables** (convenient for development):
    - `INIT_ADMIN_USERNAME`
    - `INIT_ADMIN_PASSWORD`

The initial account is created with `must_change_password` enabled.
You will be prompted to set a new password on first sign-in.

After the account is created, secret files are deleted (or a
consumed marker is written to `DATA_DIR` if deletion is not
possible). The bootstrap process does not run again once any
account exists.

## First Launch

Start the development server:

```bash
pnpm dev
```

Or start in production mode:

```bash
pnpm build
pnpm start
```

Open `http://localhost:3000` (or the configured address) in your
browser. You should see the sign-in page:

![Sign-in page](../assets/sign-in-en.png)

Enter the initial admin credentials, then set a new password when
prompted:

![Password change page](../assets/change-password-en.png)

After changing the password you are redirected to the dashboard.
