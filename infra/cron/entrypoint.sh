#!/usr/bin/env bash
#
# Cron container entrypoint (#487 §1).
#
# busybox `crond` does NOT inherit container env into spawned jobs, so
# the wrapper scripts source `/etc/cron.env` to pick up the values they
# need. This entrypoint materialises that file from the container env
# before starting `crond -f`. Keeping the allowlist explicit prevents
# unrelated container env from leaking into cron log lines / cron job
# environments.

set -euo pipefail

ENV_FILE=/etc/cron.env
LOG_DIR=/var/log/cron

# Allowlist the env vars the cron wrappers actually use. Add new
# entries here when a future cron wrapper needs them.
ENV_ALLOWLIST=(
    TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN
    NEXT_APP_BASE_URL
    # Allowlisted so `run-triage-baseline-dispatch.sh` derives its
    # `--max-time` from the same operator knob `next-app` honours.
    # Without this passthrough an operator raising the dispatcher
    # total timeout via `.env` would still be killed by the wrapper's
    # 840s default, recreating the transport-failure / no-body mode
    # the structured `skipped-timeout` row exists to prevent.
    TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS
    # 1B-7 cleanup tokens. Each retention / recovery surface uses its
    # own internal-token env var so a leaked secret cannot pivot
    # between surfaces.
    TRIAGE_BASELINE_RETENTION_INTERNAL_TOKEN
    TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN
    TRIAGE_EXCLUSION_FANOUT_TOKEN
    # Recover is operator-tooling, not scheduled; the token is passed
    # through so an operator running `curl` from `docker exec cron sh`
    # picks up the same configured secret without re-exporting it.
    TRIAGE_EXCLUSION_RECOVERY_INTERNAL_TOKEN
)

: > "$ENV_FILE"
for var in "${ENV_ALLOWLIST[@]}"; do
    # `printenv` returns non-zero when the var is unset; we treat
    # unset as "skip" so a partial config still boots.
    if value=$(printenv "$var" 2>/dev/null); then
        printf 'export %s=%q\n' "$var" "$value" >>"$ENV_FILE"
    fi
done
chmod 600 "$ENV_FILE"

mkdir -p "$LOG_DIR"

# `-f` keeps crond in the foreground; `-d 8` enables debug logging to
# stderr so `docker compose logs cron` is useful during incident
# response.
exec crond -f -d 8
