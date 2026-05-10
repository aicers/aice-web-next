import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER_PATH = resolve(
  __dirname,
  "../../../../infra/cron/run-triage-baseline-dispatch.sh",
);
const CRONTAB_PATH = resolve(__dirname, "../../../../infra/cron/crontab");
const DOCKERFILE_PATH = resolve(__dirname, "../../../../infra/cron/Dockerfile");

const wrapper = readFileSync(WRAPPER_PATH, "utf8");
const crontab = readFileSync(CRONTAB_PATH, "utf8");
const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

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
