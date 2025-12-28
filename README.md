# AICE Web (Next.js)

Next.js App Router implementation of the AICE web client with REview
authentication, localized routing, and a hybrid SSR/CSR architecture prepared
for persistent connections.

## Prerequisites

- Node 22: Use Node.js 22.x. **Do not use Node 24.**
  - nvm example: `nvm install 22 && nvm use 22`
  - macOS (Homebrew):
    - `brew update && brew install node@22`
    - Unlink the previous version: `brew unlink node`
    - Link 22: `brew link --overwrite --force node@22`
    - Verify: `node -v` should print v22.x.y
- pnpm: Use pnpm 10+.
  - macOS (Homebrew):
    - `brew install pnpm`
  - Linux (Corepack with Node 22):
    - `corepack enable`
    - `corepack prepare pnpm@10 --activate`
  - Windows (Corepack with Node 22):
    - `corepack enable`
    - `corepack prepare pnpm@10 --activate`
- Next.js: Use 15 (latest patch) for Node 22 compatibility; **do not use 16.**
  Installed via `pnpm install`.
- Docker: Install Docker (Docker Desktop or Docker Engine).
- Biome CLI 2.x (Rust binary) available on your `PATH` – download a release
  build and place `biome` somewhere executable, or compile it yourself via Cargo
  following the Biome documentation.

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

1. **(Important)** Approve build scripts (required for pnpm v9+):

   ```bash
   pnpm approve-builds
   ```

1. Install Playwright browsers (one-time per machine):

   ```bash
   pnpm exec playwright install --with-deps
   ```

   - Linux (e.g., CI runners): `--with-deps` also installs required system
     packages so browsers run out of the box.
   - macOS: the flag is effectively a no-op; it only downloads the browser
     binaries, so leaving it on is harmless.

1. Provide environment variables (`pnpm run dev` reads from `.env.local` or the
   current shell). Copy `.env.example` to `.env.local` and replace the
   placeholders:

   ```bash
   cp .env.example .env.local
   # update the endpoints inside .env.local as needed
   ```

## Docker Compose Template

- Copy the sample stack before running Docker: `cp docker-compose.yml.sample docker-compose.yml`.
- Update the `next-app` certificate volume in `docker-compose.yml` so the host
  path points to your local cert.
- Keep the personalized file out of git; only commit `docker-compose.yml.sample`.

## Available scripts

| Command | Description |
| --- | --- |
| `pnpm run dev` | Start the development server (Turbopack). |
| `pnpm run build` | Create a production build. |
| `pnpm run start` | Run the production server. |
| `pnpm run lint` | Lint and format with Biome. |
| `pnpm run typecheck` | Run TypeScript in `--noEmit` mode. |
| `pnpm run test` | Execute Vitest unit/component tests. |
| `pnpm run test:e2e` | Run Playwright end-to-end tests. |

## Internationalisation

- URL-based routing under `/[locale]/…` with default redirect handled in `middleware.ts`.
- Messages live in flat JSON files at `messages/en.json` and `messages/ko.json`;
  they are converted to nested structures at runtime for Next Intl 4.
- `LanguageSwitcher` updates the locale in-place using shared navigation helpers.

## Authentication flow

- `SignInForm` uses React Hook Form + Zod validation and calls REview’s `signIn`
  GraphQL mutation via `graphql-request`.
- Sign-in requests are proxied through `/api/review/sign-in`, which supports
  trusting self-signed certificates via `REVIEW_ALLOW_SELF_SIGNED=true` or a CA
  path (`REVIEW_CA_CERT_PATH`).
- Tokens are stored in-memory through `AuthProvider`, keeping sensitive data out
  of persistent storage.
- `createPersistentConnection` (SSE helper) is scaffolded for future real-time features.

## Tooling & Testing

- Styling: Tailwind CSS v4 + shadcn/ui components.
- Linting/formatting: Biome (`biome.json`).
- Unit/Component tests: Vitest + Testing Library (`vitest.config.ts`).
- E2E tests: Playwright (`playwright.config.ts`, `e2e/sign-in.spec.ts`).

For local tooling:

- Use `pnpm dlx <tool>` when the tool is not installed in `package.json`.
- Use `pnpm exec <tool>` when the tool is in `dependencies`/`devDependencies`.

Run the full verification suite locally (assumes Playwright browsers are already
installed; see Setup):

```bash
biome --version
biome ci --error-on-warnings .
pnpm run typecheck
pnpm run test
pnpm run test:e2e
```

## Biome Commands

Biome CLI commands follow `biome <command> [flags] [paths...]`. Each trailing
path can be a directory (Biome walks it recursively and respects
`.biomeignore`/VCS ignore files) or a single file for targeted checks. Use `.`
to cover the project root or enumerate specific paths to narrow the run.

### Checking vs. fixing

- Run commands without `--write` to only report problems (exit status reflects success/failure).
- Add `--write` to apply Biome’s safe fixes (formatting, autofixable lint
  rules). Combine with `--unsafe` if you intentionally want riskier rewrites.

### Lint

```bash
# Report lint issues without modifying files
biome lint src e2e infra messages middleware.ts next.config.ts

# Apply autofixes just like `pnpm run lint`
biome lint --write src e2e infra messages middleware.ts next.config.ts

# Fail the run whenever a warning is emitted
biome lint --error-on-warnings src e2e infra messages middleware.ts
```

### Format

```bash
# Check formatting (read-only) for the whole repo
biome format .

# Rewrite files with Biome's formatter
biome format --write .

# Limit formatting changes to specific paths
biome format --write src middleware.ts README.md
```

### Lint + format together

```bash
# Run lint + format diagnostics without modifying files
biome check .

# Apply all available safe fixes in one pass
biome check --write .
```

### CI automation

In continuous integration workflows, prefer `biome ci` for a single read-only
pass that surfaces every diagnostic (lint + format + import ordering) while
failing the build if anything is off.

```bash
# Check the whole repo with GitHub-friendly output
biome ci --reporter=github .

# Restrict the run to files changed against the default branch
biome ci --changed --since origin/main

# Treat warnings as failures in CI
biome ci --error-on-warnings .
```

Tune performance with `--threads=<number>` (or `BIOME_THREADS`) when the CI
runner offers limited cores. Combine any of the flags above with explicit path
lists if you only want to validate certain directories.

## Local Development

```bash
# Ensure `.env.local` is populated for dev secrets
pnpm run dev
```

- The dev server listens on `http://localhost:3000` with hot reload.
- To expose HTTPS through Docker, the repo ships with:
  - `infra/nginx/nginx.dev.conf`: Nginx reverse proxy pointing to `host.docker.internal:3000`.
  - `docker-compose.profiles.yml`: Adds a `nginx-dev` service (profile `dev`) and
    restricts the production stack to profile `prod`.
- Start or stop the proxy as needed (after `pnpm run dev` is running):

<!-- markdownlint-disable MD013 -->
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.profiles.yml --profile dev up -d nginx-dev
  docker compose -f docker-compose.yml -f docker-compose.profiles.yml --profile dev down
  ```
<!-- markdownlint-enable MD013 -->

- On Linux, confirm your Docker engine is 20.10+ (or otherwise configured) so
  containers can resolve `host.docker.internal` back to the host loopback. Older
  versions do not expose that hostname by default; if you cannot upgrade, edit
  `infra/nginx/nginx.dev.conf` to point at an alternate host such as the Docker
  bridge gateway (`172.17.0.1`) or add your own mapping via
  `extra_hosts: ["my-hostname:127.0.0.1"]` and reference that name instead.

## Production Deployment (Docker)

### Bring the stack online

- Populate `.env` with production secrets and place server certificates under
  `./certs/`.
- Build and start both containers (proxy + Next.js app):

<!-- markdownlint-disable MD013 -->
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.profiles.yml --profile prod up --build -d nginx
  ```
<!-- markdownlint-enable MD013 -->

- Reuse previously built images with `--no-build`.
- Tail logs as needed: `docker compose ... --profile prod logs -f nginx next-app`.

### Tear down

<!-- markdownlint-disable MD013 -->
```bash
docker compose -f docker-compose.yml -f docker-compose.profiles.yml --profile prod down
```
<!-- markdownlint-enable MD013 -->

### Stack components

- Next.js application (`Dockerfile`, based on `node:22-bookworm` with digest pinning)
- Nginx reverse proxy (`infra/nginx/Dockerfile`)

This builds both images, starts the Next.js app on the internal network, and
exposes HTTPS on port 443 through Nginx.

### Offline Image Bundle

Run the helper script to build the required images, save them as tarballs, and
collect the compose files and environment configuration into a single
deployment bundle.
By default the script targets `linux/amd64`, which is suitable for typical Linux
hosts even when you run the script from Apple Silicon macOS. Override `ENV_FILE`
to package a different env file, `IMAGE_TAG` to re-tag the exported images, and
`PLATFORM` to build for another architecture.

```bash
bash infra/scripts/package-deployment.sh dist/deployment
# Example: override defaults
#   ENV_FILE=/path/to/prod.env IMAGE_TAG=prod \
#   bash infra/scripts/package-deployment.sh /tmp/aice-bundle
# Apple Silicon → build for arm64 instead
#   PLATFORM=linux/arm64 \
#   bash infra/scripts/package-deployment.sh
```

The default output directory (`dist/deployment`) contains:

- `aice-web-next.tar`, `aice-nginx.tar`: exported Docker images
- `docker-compose.yml`: base Compose stack definition
- `docker-compose.profiles.yml` (if present): profile overrides used in this repo
- `.env`: environment variables (defaults to the repo’s `.env`; override with `ENV_FILE`)
- `README_PACKAGING.md`: quick-start guide for the target host

On the destination host:

1. Load the images.

   ```bash
   docker load -i aice-web-next.tar
   docker load -i aice-nginx.tar
   ```

1. Provide the required supporting files (Nginx config, TLS certs under
   `./certs`, `docker-compose.profiles.yml`, etc.).
1. Start the stack without rebuilding:

   ```bash
   docker compose \
     -f docker-compose.yml \
     -f docker-compose.profiles.yml \
     --profile prod up --no-build -d nginx
   ```

## Environment Variables

- `NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT` / `REVIEW_GRAPHQL_ENDPOINT`: REview
  GraphQL endpoint (public vs. server-only).
- `REVIEW_ALLOW_SELF_SIGNED`: Set to `true` to skip TLS verification when using
  self-signed certificates (dev only).
- `REVIEW_CA_CERT_PATH`: Absolute path to a CA bundle that should be trusted
  when contacting REview.
- `REVIEW_TLS_SERVERNAME`: Override the TLS SNI/hostname sent when connecting to
  REview (useful when certificates do not include `localhost`).
- `NEXT_PUBLIC_REVIEW_STREAM_ENDPOINT`: (future use) streaming endpoint for
  persistent connections.

## Reverse Proxy (Nginx)

- Configuration: `infra/nginx/nginx.conf` (upstream points to the
  `next-app:3000` service used by Compose).
- Development override: `infra/nginx/nginx.dev.conf` proxies to
  `host.docker.internal:3000` when the app runs on the host.
- `infra/nginx/Dockerfile` builds the proxy image; Compose handles building and
  running it alongside the app.
- Replace `server_name` and TLS certificate paths to match your deployment.
- Ensure `./certs` contains the certificate/key pair referenced in the config;
  Compose mounts it into `/etc/nginx/ssl`.
- Generate local self-signed certs (dev only) via
  `infra/scripts/generate-self-signed-cert.sh <hostname> <output-dir>` and store
  them under `./certs`.

## Continuous Integration

GitHub Actions workflow `.github/workflows/ci.yml` runs lint, typecheck, unit
tests, installs Playwright browsers, and executes E2E tests on every push and
pull request.
