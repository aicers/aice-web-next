#!/usr/bin/env bash
#
# Triage exclusion fanout wrapper (#461 / 1B-7).
#
# 1B-2 (#457) shipped the `/api/internal/triage/exclusion/fanout`
# route + the worker's stuck-job sweep but no crontab entry. 1B-7
# closes that gap with a minute-scale invocation matching the
# cadence assumption the worker's exponential backoff (1m / 5m / 25m /
# 2h / 12h) is built around — a slower cadence would force every
# attempt through one stuck-job sweep, halving effective throughput
# under contention.
#
# Same wrapper contract as the cadence-dispatch / retention scripts.

set -u

ENV_FILE="${CRON_FANOUT_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_FANOUT_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${TRIAGE_EXCLUSION_FANOUT_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/triage/exclusion/fanout"

CONNECT_TIMEOUT_S="${CRON_FANOUT_CONNECT_TIMEOUT_S:-10}"
# Minute-scale ceiling so an overlapping tick never deadlines past the
# next scheduled tick. The worker's claim batch is bounded so any
# single sweep finishes well inside this window; if it does not, the
# next tick re-claims via the stuck-job sweep without harm.
MAX_TIME_S="${CRON_FANOUT_MAX_TIME_S:-55}"

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-fanout-${TS}.json"

log_info() {
    printf '[%s] cron-fanout: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-fanout: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "TRIAGE_EXCLUSION_FANOUT_TOKEN is empty; refusing to fire"
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
        log_warn "auth failure (HTTP ${http_code}); check TRIAGE_EXCLUSION_FANOUT_TOKEN"
        exit 1
        ;;
    200)
        ;;
    *)
        if jq -e . "$BODY_FILE" >/dev/null 2>&1; then
            err=$(jq -r '.error // empty' "$BODY_FILE")
            log_warn "HTTP ${http_code} (error=${err:-?}); body=${BODY_FILE}"
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

summary=$(
    jq -r '
        [
            "recovered=" + ((.recovered // 0) | tostring),
            "claimed=" + ((.claimed // 0) | tostring),
            "completed=" + ((.completed // 0) | tostring),
            "retried=" + ((.retried // 0) | tostring),
            "failed=" + ((.failed // 0) | tostring)
        ] | join(" ")
    ' "$BODY_FILE"
)

log_info "${summary} body=${BODY_FILE}"

# A single `failed` finalisation is operationally significant: the
# fanout worker has exhausted the backoff budget and an operator
# needs to re-trigger cleanup. Surface to stderr so MAILTO can
# escalate, but still exit 0 so cron does not double-page on every
# subsequent tick.
failed_count=$(jq -r '.failed // 0' "$BODY_FILE")
if [ "$failed_count" -gt 0 ]; then
    log_warn "${failed_count} fanout row(s) finalized as failed; admin recovery required (body=${BODY_FILE})"
fi

exit 0
