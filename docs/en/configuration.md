# Configuration

This page covers environment variables, database connections, mTLS
certificates, and the Nginx reverse proxy.

## Environment Variables

Copy `.env.example` to `.env.local` and set the values for your
environment. The table below lists all variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string for `auth_db` |
| `DATABASE_ADMIN_URL` | Yes | Admin connection used for `CREATE DATABASE` / `DROP DATABASE` during customer provisioning |
| `AUDIT_DATABASE_URL` | Yes | PostgreSQL connection string for `audit_db` (use a restricted role) |
| `REVIEW_GRAPHQL_ENDPOINT` | Yes | GraphQL endpoint of the review-web backend |
| `MTLS_CERT_PATH` | Yes | Path to the mTLS client certificate (PEM) |
| `MTLS_KEY_PATH` | Yes | Path to the mTLS client private key (PEM) |
| `MTLS_CA_PATH` | Yes | Path to the mTLS CA certificate (PEM) |
| `DATA_DIR` | No | Directory for keys and markers (default: `./data`) |
| `JWT_EXPIRATION_MINUTES` | No | JWT lifetime in minutes (default: `15`) |
| `CSRF_SECRET` | Yes | Secret key for CSRF token HMAC |
| `INIT_ADMIN_USERNAME` | No | Initial admin username (see [Getting Started](getting-started.md)) |
| `INIT_ADMIN_PASSWORD` | No | Initial admin password |
| `DEFAULT_LOCALE` | No | Default UI language: `en` or `ko` (default: `en`) |

## Database Setup

AICE Web uses three categories of PostgreSQL databases:

- **auth_db** — accounts, roles, sessions, customers, system
  settings, and password history.
- **audit_db** — immutable audit log records. The connection role
  needs `CREATE` and `USAGE` on the `public` schema (the
  application runs migrations on startup) plus `INSERT` and
  `SELECT` on tables for tamper resistance.
- **Customer databases** — provisioned automatically when a
  customer is created. Managed through `DATABASE_ADMIN_URL`, which
  needs `CREATE DATABASE` / `DROP DATABASE` privileges.

All schema migrations run automatically on application startup.
Customer database migrations also run at provisioning time.

### Connection String Format

```text
postgres://user:password@host:5432/dbname
```

For production, use SSL connections:

```text
postgres://user:password@host:5432/dbname?sslmode=require
```

## mTLS Certificates

AICE Web authenticates to the review-web backend using mutual TLS.
Three files are required:

| Variable | File |
|----------|------|
| `MTLS_CERT_PATH` | Client certificate (PEM) |
| `MTLS_KEY_PATH` | Client private key (PEM) |
| `MTLS_CA_PATH` | CA certificate that signed the server cert (PEM) |

Ensure the files are readable by the application process and stored
outside the web-accessible directory. The dashboard displays a
warning when certificates are near expiry.

## Nginx Reverse Proxy

A sample production Nginx configuration is provided at
`infra/nginx/nginx.prod.conf`. Key features:

- **HTTP → HTTPS redirect** — port 80 returns `301` to HTTPS.
- **HSTS** — `Strict-Transport-Security` with a one-year
  `max-age`.
- **Security headers** — `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- **WebSocket support** — `Upgrade` and `Connection` headers
  are forwarded.
- **Deferred DNS** — upstream is resolved at request time via a
  `set $upstream` variable, allowing Nginx to start before the
  application is ready.

### Minimal Configuration

```nginx
server {
    listen 80;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;

    ssl_certificate     /etc/nginx/certs/prod.crt;
    ssl_certificate_key /etc/nginx/certs/prod.key;

    add_header Strict-Transport-Security
        "max-age=31536000; includeSubDomains" always;

    location / {
        set $upstream http://next-app:3000;
        proxy_pass $upstream;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For
            $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## JWT Signing Key

AICE Web uses a dedicated signing key (separate from mTLS keys)
for JWT tokens. The key is stored in `DATA_DIR/keys/` and supports
`kid`-based rotation. The key is generated automatically on first
startup if it does not exist.

## CSRF Protection

CSRF tokens use HMAC-SHA256 with the `CSRF_SECRET` value. The
token is stored in a `__Host-csrf` cookie in production (requires
HTTPS) or a `csrf` cookie in development (HTTP). It is validated
via the `X-CSRF-Token` header on mutating requests to Route
Handlers. Server Actions are exempt (Next.js provides built-in
CSRF protection).

Generate a strong random secret:

```bash
openssl rand -base64 32
```
