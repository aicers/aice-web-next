#!/usr/bin/env bash
#
# Triage baseline dispatch wrapper (#487 §3).
#
# Invoked every 15 minutes by `/etc/crontabs/root` inside the cron
# container.
# Owns:
#   - sourcing /etc/cron.env (set by entrypoint.sh, since busybox
#     crond does NOT propagate container env into jobs)
#   - hitting POST /api/internal/triage/baseline/dispatch
#   - separating HTTP status from response body (so a 4xx/5xx with a
#     meaningful body is not silently dropped)
#   - parsing `overall` with a real JSON parser (`jq`)
#   - emitting a one-line summary to stdout and a stderr warning when
#     `overall != 'ok'`
#   - capturing the full response body to a timestamped file under
#     /var/log/cron/
#
# Exit code policy:
#   - exit 0 on HTTP 200 (regardless of `overall`) and on HTTP 4xx/5xx
#     with a parseable body — the structured body is the recovery
#     surface; the next 15-minute tick re-runs and confirms whether
#     the issue persists. cron's MAILTO would otherwise double-page.
#   - exit non-zero on transport failure (DNS, connection refused,
#     TLS, --max-time reached), on HTTP 401/403 (auth misconfig must
#     surface to ops), and on configuration errors (missing token /
#     URL).
#
# `set -e` is INTENTIONALLY NOT used here: it would abort the script
# the moment curl exits non-zero (transport failure, timeout) before
# the failure-classification block could run. We capture curl's exit
# code with `|| curl_exit=$?` and classify explicitly.

set -u

# Both paths are overridable via env so the script can be exercised
# end-to-end from tests (which cannot write to /var/log/cron and have
# no /etc/cron.env on the host). Production crontab leaves these
# unset; the entrypoint controls the real paths.
ENV_FILE="${CRON_CADENCE_ENV_FILE:-/etc/cron.env}"
LOG_DIR="${CRON_CADENCE_LOG_DIR:-/var/log/cron}"

if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

TOKEN="${TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN:-}"
BASE_URL="${NEXT_APP_BASE_URL:-http://next-app:3000}"
URL="${BASE_URL}/api/internal/triage/baseline/dispatch"

# `--max-time` is a hard wall-clock cap including connect + transfer.
# Keep it equal to the dispatcher's total timeout (14 minutes = 840s
# default) so the application-level timeout — which produces
# structured `skipped-timeout` rows for unattempted customers — wins
# over the network-level timeout (which would surface as a transport
# failure with no body). The 15-minute cron interval (900s) is the
# absolute ceiling — successive ticks must not overlap.
#
# Resolution order (highest precedence first):
#   1. CRON_CADENCE_MAX_TIME_S — test override only, lets the wrapper
#      run with sub-second ceilings under vitest.
#   2. TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS — operator-tunable
#      knob shared with `next-app`, allowlisted by `entrypoint.sh`
#      into `/etc/cron.env`. Converted ms → s and rounded UP so the
#      wrapper never undercuts the app deadline. A floor of 1s
#      guarantees a positive value even if an operator misconfigures
#      the knob (e.g. sets it below 500ms). Capped at 840s so a stale
#      `…=2700000` left over from the old hourly cadence cannot
#      silently push the wrapper past the 15-minute cron interval
#      (900s) and overlap the next tick — the dispatcher applies the
#      same clamp app-side.
#   3. 840s default — matches the dispatcher's own default total
#      timeout (14 minutes).
CONNECT_TIMEOUT_S="${CRON_CADENCE_CONNECT_TIMEOUT_S:-10}"
MAX_TIME_CEILING_S=840
if [ -n "${CRON_CADENCE_MAX_TIME_S:-}" ]; then
    MAX_TIME_S="$CRON_CADENCE_MAX_TIME_S"
elif [ -n "${TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS:-}" ]; then
    MAX_TIME_S=$((
        (TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS + 999) / 1000
    ))
    if [ "$MAX_TIME_S" -lt 1 ]; then
        MAX_TIME_S=1
    fi
    if [ "$MAX_TIME_S" -gt "$MAX_TIME_CEILING_S" ]; then
        printf '[%s] cron-cadence: WARN TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS=%s exceeds cron-interval-safe ceiling %ss; clamping --max-time to %ss\n' \
            "$(date -Iseconds)" \
            "$TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS" \
            "$MAX_TIME_CEILING_S" \
            "$MAX_TIME_CEILING_S" >&2
        MAX_TIME_S="$MAX_TIME_CEILING_S"
    fi
else
    MAX_TIME_S="$MAX_TIME_CEILING_S"
fi

mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
BODY_FILE="${LOG_DIR}/cron-cadence-${TS}.json"

log_info() {
    printf '[%s] cron-cadence: %s\n' "$(date -Iseconds)" "$*"
}

log_warn() {
    printf '[%s] cron-cadence: WARN %s\n' "$(date -Iseconds)" "$*" >&2
}

if [ -z "$TOKEN" ]; then
    log_warn "TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN is empty; refusing to fire"
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

# Empty / unreadable http_code on a transport failure: classify as
# transport error regardless of curl_exit (defense in depth — old
# busybox curl can occasionally exit 0 while leaving the body file
# empty when the connection drops mid-transfer).
if [ "$curl_exit" -ne 0 ] || [ -z "$http_code" ]; then
    log_warn "transport failure (curl_exit=${curl_exit}, http_code='${http_code}', url=${URL})"
    exit 1
fi

case "$http_code" in
    401|403)
        log_warn "auth failure (HTTP ${http_code}); check TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN"
        exit 1
        ;;
    200)
        # fall through to body parsing
        ;;
    *)
        # Other HTTP errors (4xx/5xx). The body may carry a structured
        # explanation (e.g. dispatcher self-failure with `error`).
        # Summarise to stderr but exit 0 — cron retry semantics handle
        # the next tick; non-zero would double-trigger MAILTO.
        if jq -e . "$BODY_FILE" >/dev/null 2>&1; then
            err=$(jq -r '.error // empty' "$BODY_FILE")
            overall=$(jq -r '.overall // empty' "$BODY_FILE")
            log_warn "HTTP ${http_code} from dispatcher (overall=${overall:-?}, error=${err:-?}); body saved to ${BODY_FILE}"
        else
            log_warn "HTTP ${http_code} from dispatcher (body unparseable); body saved to ${BODY_FILE}"
        fi
        exit 0
        ;;
esac

# HTTP 200: parse `overall` and per-customer counters.
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
