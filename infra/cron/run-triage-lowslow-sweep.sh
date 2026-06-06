#!/usr/bin/env bash
#
# Triage low-and-slow sweep wrapper (issue #701).
#
# Invoked hourly by `/etc/crontabs/root` inside the cron container.
# Mirrors run-triage-baseline-dispatch.sh: it sources /etc/cron.env
# (busybox crond does NOT propagate container env into jobs), hits
# POST /api/internal/triage/baseline/lowslow-sweep, separates HTTP
# status from response body, parses `overall` with `jq`, emits a
# one-line summary, and captures the full body to a timestamped file.
#
# Exit code policy (identical to the dispatch wrapper):
#   - exit 0 on HTTP 200 (regardless of `overall`) and on HTTP 4xx/5xx
#     with a parseable body — the next hourly tick re-runs and confirms
#     whether the issue persists.
#   - exit non-zero on transport failure, on HTTP 401/403 (auth
#     misconfig must surface), and on configuration errors.
#
# `set -e` is INTENTIONALLY NOT used: it would abort the moment curl
# exits non-zero before the failure-classification block could run.

set -u

ENV_FILE="${CRON_LOWSLOW_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_LOWSLOW_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/triage/baseline/lowslow-sweep"

# `--max-time` is a hard wall-clock cap. Keep it equal to the
# dispatcher's total timeout (55 minutes = 3300s default) so the
# application-level timeout — which produces structured
# `skipped-timeout` rows for unattempted customers — wins over the
# network-level timeout. The 60-minute cron interval (3600s) is the
# absolute ceiling — successive hourly ticks must not overlap.
#
# Resolution order (highest precedence first):
#   1. CRON_LOWSLOW_MAX_TIME_S — test override only.
#   2. LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS — operator-tunable knob
#      shared with `next-app`, allowlisted by `entrypoint.sh`.
#      Converted ms → s, rounded UP, floored at 1s, capped at 3300s.
#   3. 3300s default — matches the dispatcher's own default total
#      timeout (55 minutes).
CONNECT_TIMEOUT_S="${CRON_LOWSLOW_CONNECT_TIMEOUT_S:-10}"
MAX_TIME_CEILING_S=3300
if [ -n "${CRON_LOWSLOW_MAX_TIME_S:-}" ]; then
    MAX_TIME_S="$CRON_LOWSLOW_MAX_TIME_S"
elif [ -n "${LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS:-}" ]; then
    MAX_TIME_S=$((
        (LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS + 999) / 1000
    ))
    if [ "$MAX_TIME_S" -lt 1 ]; then
        MAX_TIME_S=1
    fi
    if [ "$MAX_TIME_S" -gt "$MAX_TIME_CEILING_S" ]; then
        printf '[%s] cron-lowslow: WARN LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS=%s exceeds cron-interval-safe ceiling %ss; clamping --max-time to %ss\n' \
            "$(date -Iseconds)" \
            "$LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS" \
            "$MAX_TIME_CEILING_S" \
            "$MAX_TIME_CEILING_S" >&2
        MAX_TIME_S="$MAX_TIME_CEILING_S"
    fi
else
    MAX_TIME_S="$MAX_TIME_CEILING_S"
fi

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-lowslow-${TS}.json"

log_info() {
    printf '[%s] cron-lowslow: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-lowslow: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN is empty; refusing to fire"
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
        log_warn "auth failure (HTTP ${http_code}); check TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN"
        exit 1
        ;;
    200)
        # fall through to body parsing
        ;;
    *)
        if jq -e . "$BODY_FILE" >/dev/null 2>&1; then
            err=$(jq -r '.error // empty' "$BODY_FILE")
            overall=$(jq -r '.overall // empty' "$BODY_FILE")
            log_warn "HTTP ${http_code} from lowslow sweep (overall=${overall:-?}, error=${err:-?}); body saved to ${BODY_FILE}"
        else
            log_warn "HTTP ${http_code} from lowslow sweep (body unparseable); body saved to ${BODY_FILE}"
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
            "skipped=" + ([.perCustomer[]? | select(.status == "skipped")] | length | tostring),
            "failed=" + ([.perCustomer[]? | select(.status == "failed")] | length | tostring),
            "timeout=" + ([.perCustomer[]? | select(.status == "timeout")] | length | tostring),
            "skipped_timeout=" + ([.perCustomer[]? | select(.status == "skipped-timeout")] | length | tostring)
        ] | join(" ")
    ' "$BODY_FILE"
)

log_info "overall=${overall} ${counts} body=${BODY_FILE}"

if [ "$overall" != "ok" ]; then
    bad_ids=$(
        jq -r '
            [.perCustomer[]?
                | select(.status != "ok" and .status != "skipped")
                | (.customerId | tostring) + ":" + .status]
            | join(",")
        ' "$BODY_FILE"
    )
    log_warn "overall=${overall}: ${bad_ids:-none}; body=${BODY_FILE}"
fi

exit 0
