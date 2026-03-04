# aice-web-next

Web UI for AICE, built with Next.js.

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000> to see the result.

## HTTPS

Production deployments must be served over HTTPS. The nginx reverse
proxy handles TLS termination and redirects all HTTP traffic to HTTPS.

### Production

The production nginx config (`infra/nginx/nginx.prod.conf`) enables:

- HTTP → HTTPS redirect (port 80 → 443)
- HSTS with a 1-year `max-age` and `includeSubDomains`
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`

The `__Host-csrf` cookie and `Secure` flag on the access token cookie
are automatically enabled when `NODE_ENV=production` (set by the
Dockerfile).

### Development with Docker Compose

```bash
# Generate self-signed TLS certificates (one-time)
mkdir -p infra/certs
mkcert -install  # trust the local CA (optional, avoids browser warnings)
mkcert -key-file infra/certs/dev.key -cert-file infra/certs/dev.crt localhost

# Start nginx + PostgreSQL
docker compose --profile dev up -d

# Start the Next.js dev server (in a separate terminal)
pnpm dev
```

Visit <https://localhost>. Nginx terminates TLS and proxies to
`localhost:3000`.

If you don't have `mkcert`, self-signed certificates also work but
the browser will show a security warning:

```bash
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout infra/certs/dev.key -out infra/certs/dev.crt \
  -days 365 -subj '/CN=localhost'
```

### Development without Docker

Running `pnpm dev` directly serves over HTTP on port 3000. This is
acceptable for local development because `NODE_ENV` is not
`production`, so:

- The CSRF cookie uses `csrf` instead of `__Host-csrf`
- The `Secure` flag is not set on cookies
- No HSTS or security headers are applied (these come from nginx)
