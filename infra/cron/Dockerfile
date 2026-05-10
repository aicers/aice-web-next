# In-repo cron service (#487).
#
# A small Alpine image that owns hourly internal-API triggers (the
# Triage baseline dispatcher today; cleanup / retention endpoints
# later). Every hourly tick is a one-liner in `crontab` invoking a
# wrapper script under `/usr/local/bin/`. The wrapper does the actual
# curl + JSON-body capture + structured logging.
#
# Why the chosen base image:
#   - Alpine ships busybox `crond` directly (no separate cron pkg).
#   - We need a real JSON parser (`jq`) to read `overall` from the
#     dispatcher response — `grep` is rejected by #487 §3.
#   - `bash` keeps the wrapper-script syntax portable (the script
#     uses `set -u` + `${var:?}` shapes that busybox sh tolerates,
#     but parameter-expansion fallbacks are noticeably nicer in bash).
#   - `tini` reaps zombie children spawned by short-lived cron jobs.
FROM alpine:3.20

RUN apk add --no-cache bash curl jq tini coreutils

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY crontab /etc/crontabs/root
COPY run-triage-baseline-dispatch.sh /usr/local/bin/run-triage-baseline-dispatch.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
        /usr/local/bin/run-triage-baseline-dispatch.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
