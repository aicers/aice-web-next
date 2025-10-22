#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${1:-"$ROOT_DIR/dist/deployment"}"
ENV_FILE="${ENV_FILE:-"$ROOT_DIR/.env"}"
COMPOSE_FILE="${COMPOSE_FILE:-"$ROOT_DIR/docker-compose.yml"}"
COMPOSE_PROFILES_FILE="${COMPOSE_PROFILES_FILE:-"$ROOT_DIR/docker-compose.profiles.yml"}"

NEXT_IMAGE_NAME="${NEXT_IMAGE_NAME:-aice-web-next}"
NGINX_IMAGE_NAME="${NGINX_IMAGE_NAME:-aice-nginx}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
TARGET_PLATFORM="${PLATFORM:-linux/amd64}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker-compose)
else
  echo "Error: docker compose CLI is required (Docker Desktop 3.4+ or docker-compose)." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "[package] Building application and proxy images for $TARGET_PLATFORM..."
DOCKER_DEFAULT_PLATFORM="$TARGET_PLATFORM" \
  "${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" --project-directory "$ROOT_DIR" build next-app nginx

NEXT_IMAGE_ARCHIVE="$OUTPUT_DIR/${NEXT_IMAGE_NAME}.tar"
NGINX_IMAGE_ARCHIVE="$OUTPUT_DIR/${NGINX_IMAGE_NAME}.tar"
SOURCE_NEXT_IMAGE="${NEXT_IMAGE_NAME}:latest"
SOURCE_NGINX_IMAGE="${NGINX_IMAGE_NAME}:latest"
TARGET_NEXT_IMAGE="${NEXT_IMAGE_NAME}:${IMAGE_TAG}"
TARGET_NGINX_IMAGE="${NGINX_IMAGE_NAME}:${IMAGE_TAG}"

if ! docker image inspect "$SOURCE_NEXT_IMAGE" >/dev/null 2>&1; then
  echo "Error: source image '$SOURCE_NEXT_IMAGE' was not found. Did the compose build succeed?" >&2
  exit 1
fi

if ! docker image inspect "$SOURCE_NGINX_IMAGE" >/dev/null 2>&1; then
  echo "Error: source image '$SOURCE_NGINX_IMAGE' was not found. Did the compose build succeed?" >&2
  exit 1
fi

if [[ "$IMAGE_TAG" != "latest" ]]; then
  echo "[package] Tagging images as :${IMAGE_TAG}"
  docker tag "$SOURCE_NEXT_IMAGE" "$TARGET_NEXT_IMAGE"
  docker tag "$SOURCE_NGINX_IMAGE" "$TARGET_NGINX_IMAGE"
else
  TARGET_NEXT_IMAGE="$SOURCE_NEXT_IMAGE"
  TARGET_NGINX_IMAGE="$SOURCE_NGINX_IMAGE"
fi

echo "[package] Saving ${NEXT_IMAGE_NAME}:${IMAGE_TAG} -> $NEXT_IMAGE_ARCHIVE"
docker save "$TARGET_NEXT_IMAGE" -o "$NEXT_IMAGE_ARCHIVE"

echo "[package] Saving ${NGINX_IMAGE_NAME}:${IMAGE_TAG} -> $NGINX_IMAGE_ARCHIVE"
docker save "$TARGET_NGINX_IMAGE" -o "$NGINX_IMAGE_ARCHIVE"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: environment file '$ENV_FILE' not found. Set ENV_FILE=/path/to/.env before running." >&2
  exit 1
fi

echo "[package] Copying compose file and environment configuration..."
cp "$COMPOSE_FILE" "$OUTPUT_DIR/docker-compose.yml"
cp "$ENV_FILE" "$OUTPUT_DIR/.env"
if [[ -f "$COMPOSE_PROFILES_FILE" ]]; then
  cp "$COMPOSE_PROFILES_FILE" "$OUTPUT_DIR/docker-compose.profiles.yml"
fi

cat <<'EOF' >"$OUTPUT_DIR/README_PACKAGING.md"
# Offline Image Bundle

Loaded artifacts:

- docker-compose.yml
- .env
- aice-web-next.tar
- aice-nginx.tar

To use on the target host:

1. Copy all files to the destination directory.
2. Load the images:
   `docker load -i aice-web-next.tar`
   `docker load -i aice-nginx.tar`
3. Launch the stack without rebuilding:
   `docker compose up --no-build nginx`

Ensure the supporting directories are copied over as well:

- `./certs/`: TLS certificates expected by `docker-compose.yml`.
- `./infra/nginx/`: Nginx configuration referenced by the proxy service.

These paths are omitted from the bundle because they typically contain
environment-specific secrets—bring them alongside the exported images before
running `docker compose`.
EOF

echo "[package] Deployment bundle created at $OUTPUT_DIR"
