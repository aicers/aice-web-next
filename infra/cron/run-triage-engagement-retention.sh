#!/usr/bin/env bash
#
# Triage engagement-signal retention wrapper (#588).
#
# Hits POST /api/internal/triage/engagement/retention once per
# daily tick. The dispatcher enumerates active customers and runs
# the engagement-signal sweep against each tenant DB:
#
#   - `engagement_impression` rows older than 90 days from
#     `created_at` are deleted.
#   - `engagement_action`     rows older than 180 days from
#     `created_at` are deleted.
#
# Follows the wrapper contract from the snapshot retention script:
#   - source /etc/cron.env (busybox crond does not propagate env)
#   - separate HTTP status from body via curl `-w '%{http_code}'`
#   - parse `overall` / per-customer counters with jq
#   - log info to stdout, warn to stderr
#   - exit 0 on parseable responses; non-zero only on transport /
#     auth / config failures so cron MAILTO does not double-page
#     on structured per-customer failures.

set -u

ENV_FILE="${CRON_RETENTION_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_RETENTION_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/triage/engagement/retention"

CONNECT_TIMEOUT_S="${CRON_RETENTION_CONNECT_TIMEOUT_S:-10}"
# The sweep is bounded by `created_at` and batched at 10,000 rows
# per DELETE. Even at the worst-case 7,000-row impression batch
# per menu load, 90 days of churn for a busy tenant stays well
# under the 30-minute ceiling.
MAX_TIME_S="${CRON_RETENTION_MAX_TIME_S:-1800}"

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-engagement-retention-${TS}.json"

log_info() {
    printf '[%s] cron-engagement-retention: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-engagement-retention: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN is empty; refusing to fire"
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
        log_warn "auth failure (HTTP ${http_code}); check TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN"
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
            "impressions_pruned=" + ([.perCustomer[]?.counts.engagementImpression // 0] | add | tostring),
            "actions_pruned=" + ([.perCustomer[]?.counts.engagementAction // 0] | add | tostring)
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
