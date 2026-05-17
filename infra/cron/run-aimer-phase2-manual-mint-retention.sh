#!/usr/bin/env bash
#
# Aimer Phase 2 manual-mint retention wrapper (#493).
#
# Hits POST /api/internal/aimer/phase2/manual-mint/retention once per
# daily tick. The dispatcher enumerates active customers and prunes
# `aimer_phase2_manual_mint` rows older than 24h (consumed or not).
# Abandoned sends INSERT a ledger row that never gets consumed; without
# this sweep the table grows unbounded.
#
# Follows the same wrapper contract as the triage retention scripts:
#   - source /etc/cron.env (busybox crond does not propagate env)
#   - separate HTTP status from body via curl `-w '%{http_code}'`
#   - parse `overall` / per-customer counters with jq
#   - log info to stdout, warn to stderr
#   - exit 0 on parseable responses; non-zero only on transport /
#     auth / config failures so cron MAILTO does not double-page on
#     structured per-customer failures.

set -u

ENV_FILE="${CRON_RETENTION_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_RETENTION_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/aimer/phase2/manual-mint/retention"

CONNECT_TIMEOUT_S="${CRON_RETENTION_CONNECT_TIMEOUT_S:-10}"
# Manual-mint rows are small (a JTI string + a few scalars), the index
# on `minted_at` keeps each batch tight, and the 24h horizon caps total
# eligible rows to one day's manual sends. 10 minutes is plenty for
# even the largest tenants; operators raise via env if needed.
MAX_TIME_S="${CRON_RETENTION_MAX_TIME_S:-600}"

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-aimer-manual-mint-retention-${TS}.json"

log_info() {
    printf '[%s] cron-aimer-manual-mint-retention: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-aimer-manual-mint-retention: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN is empty; refusing to fire"
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
        log_warn "auth failure (HTTP ${http_code}); check AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN"
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
            "pruned=" + ([.perCustomer[]?.counts.pruned // 0] | add | tostring)
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
