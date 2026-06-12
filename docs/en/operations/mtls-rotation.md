# mTLS certificate rotation

The BFF authenticates outbound GraphQL traffic to Central Manager (and any other
mTLS-protected backend) with a client certificate read from disk at boot.
When `bootroot` rotates that certificate the BFF must re-read the new
files **without restarting** so the next outbound request rides the
fresh credentials and in-flight requests finish on the old TLS session
they were dispatched against.

## The SIGHUP reload contract

The BFF treats `SIGHUP` as the in-process **"reload mTLS materials"**
signal. On receipt the process:

- re-reads `MTLS_CERT_PATH`, `MTLS_KEY_PATH`, and `MTLS_CA_PATH`,
- re-detects the JWT signing algorithm from the new certificate,
- re-imports the PKCS#8 private key,
- builds a new `undici.Agent` and installs it as the live dispatcher
  for subsequent requests,
- retires the previous agent — its `close()` is **deferred** until the
  last in-flight request that was dispatched against it completes, so a
  rotation never terminates a request that was already on the wire.

What `SIGHUP` does **not** touch:

- HTTP listener sockets (the Next.js server keeps serving),
- the JWT signing keys used for first-party auth (`loadSigningKeys`),
- in-process caches that are unrelated to mTLS,
- any database connection.

`SIGHUP` is intentionally narrow: it reloads only what changed, never
the entire process.

The signal handler is registered exactly once per Node process (HMR-safe
under `next dev`, and tolerant of a transient module-load failure on
first attempt). A burst of `SIGHUP`s coalesces into a single reload, but
a `SIGHUP` that arrives while a reload is already running re-reads the
disk once after the in-flight reload finishes, so a fast double rotation
always converges on the latest disk state.

## Host deployment (bootroot post-renew hook)

For a host install where `aice-web-next` runs under a process manager
(systemd, supervisord, a plain `node` invocation), register the reload
hook on the bootroot side when adding or updating the service:

```sh
bootroot service add \
  --service-name aice-web-next \
  ... \
  --post-renew-command pkill \
  --post-renew-arg=-HUP \
  --post-renew-arg=-f \
  --post-renew-arg /path/to/.next/standalone/server.js
```

`pkill -HUP -f <node-server-path>` matches the running `node ...
server.js` process and delivers the signal directly. We use the
low-level `--post-renew-command` / `--post-renew-arg` flags rather than
`--reload-style sighup` because the latter rejects path-style targets;
see bootroot commit `04bbd5c` for the rationale.

## Containerised deployment

The production `Dockerfile` ships Node as PID 1 (no `tini`, `dumb-init`,
or shell wrapper):

```dockerfile
CMD ["node", "server.js"]
```

`docker kill --signal=HUP <container>` therefore reaches the Node
process directly:

```sh
docker kill --signal=HUP aice-web-next
```

If the container image is ever wrapped with a process supervisor in a
future change, the supervisor must forward `SIGHUP` to PID 1 — otherwise
the application will never see the signal and the rotated cert will not
be picked up until the container restarts.

## Verification after rotation

Run the rotation against a fresh server start, then confirm:

1. The BFF process ID is unchanged after `bootroot rotate
   force-reissue`.
2. The next outbound GraphQL request to Central Manager presents the new client
   cert serial. The simplest check is Central Manager's access log; a debug echo
   route that reflects `X-Client-Cert-Serial` works equally well in a
   staging environment.
3. In-flight long-poll or streaming connections established before the
   signal complete normally on the old TLS session (the deferred
   `Agent.close()` contract).
4. Steady-state load during the rotation produces zero rejected JWTs —
   the per-request snapshot pairs the JWT signing key with the cert
   that's actually presented over TLS, so a "new cert + old JWT" mix
   cannot occur.

## Failure-mode catalogue

| Symptom | Probable cause |
|---|---|
| `SIGHUP` delivered but request still uses the old cert | Process is not Node directly (supervisor swallowing the signal). Check `docker top` / `ps -o pid,cmd` for the actual PID 1. |
| `[mtls] SIGHUP: reload failed` in the log | New cert/key on disk is invalid (wrong PEM, mismatched key, unsupported key type). The previous agent stays installed; investigate and re-issue. |
| `[mtls] failed to close retired agent` after rotation | Cleanup-path log only — the new agent is already serving traffic. Indicates a transient draining error on the retired agent; safe to ignore unless it persists. |
| Process restarts after `SIGHUP` | A non-Node PID 1 (e.g. `sh -c`) propagated the default `SIGHUP` action (terminate). Switch the container's `CMD` to `exec` form so Node owns PID 1. |
