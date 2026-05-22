#!/usr/bin/env bash
# Provision a customer in aice-web-next's auth_db via the admin
# `POST /api/customers` route so the per-customer DB is created in
# the same transaction (raw SQL inserts skip the provision step and
# crash `runStartupMigrations()` FATAL on the next next-app boot).
#
# The customer's `id` must match the id REview returns for the same
# customer name via its GraphQL `origCustomer` resolver. On a freshly
# provisioned aice-web-next + the reference REview manager dump that
# carries `Customer A` at id=1, reset the customers sequence to 1
# before running this script:
#
#   docker exec aice-web-next-postgres-1 \
#       psql -U postgres -d auth_db \
#       -c "SELECT setval('customers_id_seq', 1, false)"
#
# The external_key value carried in the response must also be
# registered on the aimer-web side's `trust_registry` for the
# analyze-bridge mint to verify (already handled by the multi-host
# resume guide §6 — kid `f66372c6-...`).
set -euo pipefail

ORIGIN=${AICE_WEB_NEXT_URL:-https://001.aice-web-next.aiceweb-host.test.local:9443}
ADMIN_USER=${INIT_ADMIN_USERNAME:-admin}
ADMIN_PASS=${INIT_ADMIN_PASSWORD:-Admin1234!}
NAME=${SEED_CUSTOMER_NAME:-Customer A}
EXTERNAL_KEY=${SEED_CUSTOMER_EXTERNAL_KEY:-customer-a-external-key}

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

curl -sk -c "$JAR" "$ORIGIN/sign-in" -o /dev/null
curl -sk -b "$JAR" -c "$JAR" -X POST "$ORIGIN/api/auth/sign-in" \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" \
  -o /dev/null

CSRF=$(awk '/__Host-csrf/ {print $7}' "$JAR")
if [ -z "$CSRF" ]; then
  CSRF=$(awk '/csrf/ {print $7}' "$JAR")
fi

curl -sk -b "$JAR" -X POST "$ORIGIN/api/customers" \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" \
  -d "{\"name\":\"${NAME}\",\"description\":\"E2E seeded customer matching REview ${NAME}\",\"external_key\":\"${EXTERNAL_KEY}\"}"
echo
