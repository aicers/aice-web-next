#!/usr/bin/env bash
#
# Triage policy corpus B retention wrapper (#461 / 1B-7).
#
# Hits POST /api/internal/triage/policy/retention. The dispatcher
# runs three sweeps per tenant DB:
#   - zombie-runner reaper (computing > 30 min → failed)
#   - differential retention (ready 30d / superseded 7d / failed 1d)
#   - orphan owner cleanup
#
# Same wrapper contract as the baseline retention script.

set -u

ENV_FILE="${CRON_RETENTION_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_RETENTION_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/triage/policy/retention"

CONNECT_TIMEOUT_S="${CRON_RETENTION_CONNECT_TIMEOUT_S:-10}"
MAX_TIME_S="${CRON_POLICY_RETENTION_MAX_TIME_S:-1800}"

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-policy-retention-${TS}.json"

log_info() {
    printf '[%s] cron-policy-retention: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-policy-retention: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN is empty; refusing to fire"
    exit 2
fi

curl_exit=0
http_code=$(
    curl -sS \
        --connect-timeout "$CONNECT_TIMEOUT_S" \
        --max-time "$MAX_TIME_S" \
        -o "$BODY_FILE" \
        -w '%{http_code}' \
        -X POST \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'Content-Type: application/json' \
        --data '' \
        "$URL"
) || curl_exit=$?

if [ "$curl_exit" -ne 0 ] || [ -z "$http_code" ]; then
    log_warn "transport failure (curl_exit=${curl_exit}, http_code='${http_code}', url=${URL})"
    exit 1
fi

case "$http_code" in
    401|403)
        log_warn "auth failure (HTTP ${http_code}); check TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN"
        exit 1
        ;;
    200)
        ;;
    *)
        if jq -e . "$BODY_FILE" >/dev/null 2>&1; then
            err=$(jq -r '.error // empty' "$BODY_FILE")
            overall=$(jq -r '.overall // empty' "$BODY_FILE")
            log_warn "HTTP ${http_code} (overall=${overall:-?}, error=${err:-?}); body=${BODY_FILE}"
        else
            log_warn "HTTP ${http_code} (body unparseable); body=${BODY_FILE}"
        fi
        exit 0
        ;;
esac

if ! jq -e . "$BODY_FILE" >/dev/null 2>&1; then
    log_warn "HTTP 200 but response body is not valid JSON; saved to ${BODY_FILE}"
    exit 0
fi

overall=$(jq -r '.overall // "?"' "$BODY_FILE")
counts=$(
    jq -r '
        [
            "ok=" + ([.perCustomer[]? | select(.status == "ok")] | length | tostring),
            "failed=" + ([.perCustomer[]? | select(.status == "failed")] | length | tostring),
            "zombies=" + ([.perCustomer[]?.counts.zombiesReaped // 0] | add | tostring),
            "ready_pruned=" + ([.perCustomer[]?.counts.readyPruned // 0] | add | tostring),
            "superseded_pruned=" + ([.perCustomer[]?.counts.supersededPruned // 0] | add | tostring),
            "failed_pruned=" + ([.perCustomer[]?.counts.failedPruned // 0] | add | tostring),
            "orphan_pruned=" + ([.perCustomer[]?.counts.orphanedPruned // 0] | add | tostring)
        ] | join(" ")
    ' "$BODY_FILE"
)

log_info "overall=${overall} ${counts} body=${BODY_FILE}"

if [ "$overall" != "ok" ]; then
    bad_ids=$(
        jq -r '
            [.perCustomer[]?
                | select(.status != "ok")
                | (.customerId | tostring) + ":" + .status]
            | join(",")
        ' "$BODY_FILE"
    )
    log_warn "overall=${overall}: ${bad_ids:-none}; body=${BODY_FILE}"
fi

exit 0
