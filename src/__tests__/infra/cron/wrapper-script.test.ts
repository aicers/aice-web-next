import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER_PATH = resolve(
  __dirname,
  "../../../../infra/cron/run-triage-baseline-dispatch.sh",
);
const CRONTAB_PATH = resolve(__dirname, "../../../../infra/cron/crontab");
const DOCKERFILE_PATH = resolve(__dirname, "../../../../infra/cron/Dockerfile");
const ENTRYPOINT_PATH = resolve(
  __dirname,
  "../../../../infra/cron/entrypoint.sh",
);

const wrapper = readFileSync(WRAPPER_PATH, "utf8");
const crontab = readFileSync(CRONTAB_PATH, "utf8");
const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
const entrypoint = readFileSync(ENTRYPOINT_PATH, "utf8");

describe("infra/cron/run-triage-baseline-dispatch.sh — static contract", () => {
  it("uses jq, not grep, to parse `overall`", () => {
    // #487 §3: grep-based 'parsing' of the response body is not
    // acceptable. The wrapper must use a real JSON parser.
    expect(wrapper).toMatch(/jq /);
    // No `grep "overall"` or similar.
    expect(wrapper).not.toMatch(/grep[^|\n]*overall/);
  });

  it("does not use `set -e` (so curl exit ≠ 0 reaches the failure-classification block)", () => {
    // Allow `set -u` and `set -uo pipefail`, but reject any plain
    // `set -e` / `set -eu` / `set -euxo pipefail` shape.
    const lines = wrapper.split("\n").filter((l) => l.trim().startsWith("set"));
    for (const line of lines) {
      expect(line).not.toMatch(/-[a-z]*e/);
    }
  });

  it("invokes curl with --connect-timeout AND --max-time", () => {
    expect(wrapper).toMatch(/--connect-timeout/);
    expect(wrapper).toMatch(/--max-time/);
  });

  it("captures curl exit code separately so transport failures route to the warn path", () => {
    expect(wrapper).toMatch(/curl_exit=\$\?/);
  });

  it("emits a one-line summary to stdout AND a stderr warning when overall != 'ok'", () => {
    expect(wrapper).toMatch(/log_info /);
    expect(wrapper).toMatch(/log_warn /);
    // The partial path must hit log_warn.
    expect(wrapper).toMatch(/overall != "ok"|overall != ok|overall != 'ok'/);
  });

  it("auth-failure (HTTP 401/403) exits non-zero so cron MAILTO surfaces it", () => {
    expect(wrapper).toMatch(/401\|403\)/);
    // Must `exit 1` (or any non-zero) within that case branch.
    const authBlock = wrapper.match(/401\|403\)([\s\S]*?);;/);
    expect(authBlock).not.toBeNull();
    expect(authBlock?.[1]).toMatch(/exit 1/);
  });

  it("HTTP 200 path exits 0 even when overall is partial (cron retry handles next tick)", () => {
    // Final exit at end of script is `exit 0`.
    expect(wrapper.trimEnd()).toMatch(/exit 0$/);
  });
});

describe("infra/cron/crontab — static contract", () => {
  it("invokes the wrapper script (not curl directly)", () => {
    expect(crontab).toMatch(
      /\/usr\/local\/bin\/run-triage-baseline-dispatch\.sh/,
    );
  });

  it("does not use `%` characters in the crontab line (cron interprets % as newline)", () => {
    const lines = crontab
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    for (const line of lines) {
      expect(line).not.toMatch(/%/);
    }
  });

  it("fires at the top of each hour", () => {
    expect(crontab).toMatch(/^0 \* \* \* \*/m);
  });
});

/**
 * Detect bash/jq once at module load. The wrapper requires both at
 * runtime; if a CI environment is missing them we skip the execution
 * suite rather than fail noisily (the static-contract suite still
 * runs). `curl` is replaced by a stub on PATH for these tests so the
 * full body-parsing / status-classification / log-emission pipeline
 * is exercised without depending on outbound TCP.
 */
function hasBin(name: string): boolean {
  return spawnSync("which", [name]).status === 0;
}

const EXECUTION_DEPS_AVAILABLE = hasBin("bash") && hasBin("jq");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  bodyFile: string | null;
  bodyContents: string | null;
  /**
   * `--max-time` value the wrapper passed to curl (seconds, as a
   * string), captured by the stub so derivation tests can assert it.
   */
  curlMaxTime: string | null;
}

interface RunOptions {
  /** HTTP status the stub curl reports via `-w '%{http_code}'`. */
  httpCode?: string;
  /** Body the stub writes to the `-o` output file. */
  body?: string;
  /** Stub curl exit code (default 0). 28 simulates `--max-time` hit. */
  curlExitCode?: number;
  /** Stub curl stderr (e.g. real curl emits `curl: (28) ...` on timeout). */
  curlStderr?: string;
  /** Set to null to omit the bearer token; default is a non-empty token. */
  token?: string | null;
  /**
   * Override the wrapper's max-time fallback chain.
   *   - undefined (default): use the test's "5s" override so other
   *     branches stay fast.
   *   - null: do NOT set CRON_CADENCE_MAX_TIME_S, exercising the
   *     production fallback (TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS
   *     → 2700s default).
   *   - string: explicit override.
   */
  maxTimeS?: string | null;
  /**
   * Sets TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS to exercise the
   * wrapper's ms→s derivation when CRON_CADENCE_MAX_TIME_S is unset.
   */
  dispatchTotalTimeoutMs?: string;
}

/**
 * Stub `curl` script — parses the wrapper's invocation, emits canned
 * status / body / exit code, and leaves all transport concerns out of
 * the test. Real curl is not used because the harness sandbox blocks
 * child processes from connecting to localhost-bound test sockets.
 * The stub still validates the wrapper's contract because the wrapper
 * does not care WHERE the response came from — only that:
 *   - curl exit code != 0 → transport-failure log + non-zero exit
 *   - http_code 401/403   → auth-failure log + non-zero exit
 *   - http_code 200       → body parsed by jq, summary emitted
 *   - http_code other     → structured-body warning + exit 0
 */
const CURL_STUB = `#!/bin/bash
set -u
output=""
write_directive=""
url=""
max_time=""
connect_timeout=""
while [ $# -gt 0 ]; do
    case "$1" in
        -sS|-s|-S|-v|-i)
            shift
            ;;
        --max-time)
            max_time="$2"
            shift 2
            ;;
        --connect-timeout)
            connect_timeout="$2"
            shift 2
            ;;
        -o)
            output="$2"
            shift 2
            ;;
        -w)
            write_directive="$2"
            shift 2
            ;;
        -X|-H|--data|--data-raw|--data-binary|--data-urlencode|-F|-A|-e|-u)
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -*)
            # Unknown flag with possible arg; assume single-arg flag.
            shift
            ;;
        *)
            url="$1"
            shift
            ;;
    esac
done
if [ -n "\${CRON_CADENCE_TEST_ARGS_FILE:-}" ]; then
    printf 'max_time=%s\\nconnect_timeout=%s\\nurl=%s\\n' \\
        "$max_time" "$connect_timeout" "$url" \\
        >"\${CRON_CADENCE_TEST_ARGS_FILE}"
fi
if [ -n "\${CRON_CADENCE_TEST_STDERR:-}" ]; then
    printf '%s' "\${CRON_CADENCE_TEST_STDERR}" >&2
fi
if [ -n "$output" ]; then
    if [ -n "\${CRON_CADENCE_TEST_BODY+x}" ]; then
        printf '%s' "\${CRON_CADENCE_TEST_BODY}" > "$output"
    else
        : > "$output"
    fi
fi
case "$write_directive" in
    *%\\{http_code\\}*|*http_code*)
        printf '%s' "\${CRON_CADENCE_TEST_HTTP_CODE:-000}"
        ;;
esac
exit "\${CRON_CADENCE_TEST_EXIT_CODE:-0}"
`;

describe.skipIf(!EXECUTION_DEPS_AVAILABLE)(
  "infra/cron/run-triage-baseline-dispatch.sh — execution",
  () => {
    function runWrapper(opts: RunOptions): RunResult {
      const sandbox = mkdtempSync(join(tmpdir(), "wrapper-test-"));
      const stubDir = join(sandbox, "bin");
      const logDir = join(sandbox, "log");
      const envFile = join(sandbox, "cron.env");
      try {
        // Set up curl stub on PATH.
        spawnSync("mkdir", ["-p", stubDir, logDir]);
        const stubPath = join(stubDir, "curl");
        writeFileSync(stubPath, CURL_STUB);
        chmodSync(stubPath, 0o755);

        const argsFile = join(sandbox, "curl-args.txt");
        const env: Record<string, string> = {
          PATH: `${stubDir}:${process.env.PATH ?? ""}`,
          NEXT_APP_BASE_URL: "http://stub.invalid:3000",
          CRON_CADENCE_LOG_DIR: logDir,
          CRON_CADENCE_ENV_FILE: envFile,
          CRON_CADENCE_CONNECT_TIMEOUT_S: "1",
          CRON_CADENCE_TEST_HTTP_CODE: opts.httpCode ?? "200",
          CRON_CADENCE_TEST_EXIT_CODE: String(opts.curlExitCode ?? 0),
          CRON_CADENCE_TEST_ARGS_FILE: argsFile,
        };
        if (opts.maxTimeS === undefined) {
          env.CRON_CADENCE_MAX_TIME_S = "5";
        } else if (opts.maxTimeS !== null) {
          env.CRON_CADENCE_MAX_TIME_S = opts.maxTimeS;
        }
        if (opts.dispatchTotalTimeoutMs !== undefined) {
          env.TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS =
            opts.dispatchTotalTimeoutMs;
        }
        if (opts.body !== undefined) {
          env.CRON_CADENCE_TEST_BODY = opts.body;
        }
        if (opts.curlStderr !== undefined) {
          env.CRON_CADENCE_TEST_STDERR = opts.curlStderr;
        }
        if (opts.token !== null) {
          env.TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN =
            opts.token ?? "test-token";
        }

        const result = spawnSync("bash", [WRAPPER_PATH], {
          env: env as NodeJS.ProcessEnv,
          encoding: "utf8",
          timeout: 15_000,
        });
        const files = readdirSync(logDir).filter((f) =>
          f.startsWith("cron-cadence-"),
        );
        const bodyFile = files.length > 0 ? join(logDir, files[0]) : null;
        const bodyContents = bodyFile ? readFileSync(bodyFile, "utf8") : null;
        let curlMaxTime: string | null = null;
        try {
          const argsContent = readFileSync(argsFile, "utf8");
          const m = argsContent.match(/^max_time=(.*)$/m);
          curlMaxTime = m ? m[1] : null;
        } catch {
          curlMaxTime = null;
        }
        return {
          status: result.status,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          bodyFile,
          bodyContents,
          curlMaxTime,
        };
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }

    it("HTTP 200 + overall=ok: exits 0, stdout has summary, stderr is clean", () => {
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({
          overall: "ok",
          perCustomer: [
            {
              customerId: 1,
              status: "ok",
              observedInserted: 0,
              baselineInserted: 0,
              lastEventCursor: null,
            },
          ],
        }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/overall=ok/);
      expect(r.stdout).toMatch(/ok=1 skipped=0 failed=0 timeout=0/);
      expect(r.stderr).toBe("");
      expect(r.bodyContents).toMatch(/"overall":"ok"/);
    });

    it("HTTP 200 + overall=partial: exits 0, stdout has summary, stderr WARNs with bad ids", () => {
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({
          overall: "partial",
          perCustomer: [
            {
              customerId: 1,
              status: "ok",
              observedInserted: 0,
              baselineInserted: 0,
              lastEventCursor: null,
            },
            {
              customerId: 2,
              status: "failed",
              observedInserted: 0,
              baselineInserted: 0,
              lastEventCursor: null,
              error: "boom",
            },
            {
              customerId: 3,
              status: "timeout",
              observedInserted: 0,
              baselineInserted: 0,
              lastEventCursor: null,
              error: "timed out",
            },
          ],
        }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/overall=partial/);
      expect(r.stdout).toMatch(/failed=1/);
      expect(r.stdout).toMatch(/timeout=1/);
      expect(r.stderr).toMatch(/WARN/);
      expect(r.stderr).toMatch(/2:failed/);
      expect(r.stderr).toMatch(/3:timeout/);
    });

    it("HTTP 200 + invalid JSON: exits 0 and warns", () => {
      const r = runWrapper({
        httpCode: "200",
        body: "not json {[",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/not valid JSON/);
    });

    it("HTTP 401: exits non-zero so cron MAILTO surfaces the auth misconfig", () => {
      const r = runWrapper({
        httpCode: "401",
        body: JSON.stringify({ error: "unauthorized" }),
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/auth failure \(HTTP 401\)/);
    });

    it("HTTP 403: exits non-zero (same auth-failure path as 401)", () => {
      const r = runWrapper({
        httpCode: "403",
        body: JSON.stringify({ error: "forbidden" }),
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/auth failure \(HTTP 403\)/);
    });

    it("HTTP 500 with structured body: exits 0, body saved, stderr summarises", () => {
      const r = runWrapper({
        httpCode: "500",
        body: JSON.stringify({
          overall: "failed",
          error: "enumeration failed",
        }),
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/HTTP 500 from dispatcher/);
      expect(r.stderr).toMatch(/enumeration failed/);
      expect(r.bodyContents).toMatch(/enumeration failed/);
    });

    it("HTTP 500 with unparseable body: exits 0 and warns", () => {
      const r = runWrapper({
        httpCode: "500",
        body: "<html>internal error</html>",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/HTTP 500 from dispatcher \(body unparseable\)/);
    });

    it("transport failure (curl exit 28 = --max-time): exits non-zero on the transport-failure path", () => {
      const r = runWrapper({
        httpCode: "000",
        body: "",
        curlExitCode: 28,
        curlStderr: "curl: (28) Operation timed out\n",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/transport failure/);
      expect(r.stderr).toMatch(/curl_exit=28/);
    });

    it("transport failure (curl exit 7 = connection refused): exits non-zero", () => {
      const r = runWrapper({
        httpCode: "000",
        body: "",
        curlExitCode: 7,
        curlStderr: "curl: (7) Failed to connect\n",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/transport failure/);
      expect(r.stderr).toMatch(/curl_exit=7/);
    });

    it("derives --max-time from TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS when CRON_CADENCE_MAX_TIME_S is unset", () => {
      // 5 400 000ms = 90min → 5400s. Operator-tunable knob shared
      // with `next-app`; the wrapper must keep its network ceiling
      // in sync so the structured `timeout` / `skipped-timeout` rows
      // reach the cron MAILTO surface instead of being swallowed by
      // a transport failure.
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({ overall: "ok", perCustomer: [] }),
        maxTimeS: null,
        dispatchTotalTimeoutMs: "5400000",
      });
      expect(r.status).toBe(0);
      expect(r.curlMaxTime).toBe("5400");
    });

    it("rounds derived --max-time UP so wrapper never undercuts the app deadline", () => {
      // 1500ms → 2s (ceiling), not 1s (floor). Keeps the network
      // ceiling at-or-above the application deadline by construction.
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({ overall: "ok", perCustomer: [] }),
        maxTimeS: null,
        dispatchTotalTimeoutMs: "1500",
      });
      expect(r.status).toBe(0);
      expect(r.curlMaxTime).toBe("2");
    });

    it("falls back to 2700s default when neither override nor dispatcher knob is set", () => {
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({ overall: "ok", perCustomer: [] }),
        maxTimeS: null,
      });
      expect(r.status).toBe(0);
      expect(r.curlMaxTime).toBe("2700");
    });

    it("CRON_CADENCE_MAX_TIME_S override wins over TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS", () => {
      const r = runWrapper({
        httpCode: "200",
        body: JSON.stringify({ overall: "ok", perCustomer: [] }),
        maxTimeS: "9",
        dispatchTotalTimeoutMs: "5400000",
      });
      expect(r.status).toBe(0);
      expect(r.curlMaxTime).toBe("9");
    });

    it("missing TOKEN: refuses to fire and exits non-zero", () => {
      const r = runWrapper({
        httpCode: "200",
        body: "should not be reached",
        token: null,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(
        /TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN is empty/,
      );
    });
  },
);

describe("infra/cron/entrypoint.sh — static contract", () => {
  it("allowlists TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN", () => {
    expect(entrypoint).toMatch(/TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN/);
  });

  it("allowlists NEXT_APP_BASE_URL", () => {
    expect(entrypoint).toMatch(/NEXT_APP_BASE_URL/);
  });

  it("allowlists TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS so the wrapper can derive --max-time", () => {
    // Round 2 review fix: without this passthrough, an operator
    // raising the dispatcher total timeout via .env would still be
    // killed by the wrapper's 2700s default, recreating the
    // transport-failure / no-body mode the structured
    // `skipped-timeout` row exists to prevent.
    expect(entrypoint).toMatch(/TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS/);
  });
});

describe("infra/cron/Dockerfile — static contract", () => {
  it("installs jq so the wrapper can parse the response body", () => {
    expect(dockerfile).toMatch(/apk add[^\n]*\bjq\b/);
  });

  it("installs curl so the wrapper can hit the dispatcher route", () => {
    expect(dockerfile).toMatch(/apk add[^\n]*\bcurl\b/);
  });

  it("installs bash so the wrapper's parameter-expansion shapes work portably", () => {
    expect(dockerfile).toMatch(/apk add[^\n]*\bbash\b/);
  });
});
