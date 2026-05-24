import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findContainerLocalDsnHostnames,
  isProdComposeProfile,
  POSTGRES_DSN_ENV_VARS,
  PROD_COMPOSE_ENV_VAR,
  PROD_COMPOSE_PROFILE_MARKER,
  validateProdComposeEnv,
} from "@/lib/instrumentation/env-validate";

const TRACKED_ENV_VARS = [
  PROD_COMPOSE_ENV_VAR,
  "EXPECTED_ORIGIN",
  ...POSTGRES_DSN_ENV_VARS,
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of TRACKED_ENV_VARS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("validateProdComposeEnv", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = snapshotEnv();
    for (const key of TRACKED_ENV_VARS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  // ── profile gate ────────────────────────────────────────────────

  describe("profile gate", () => {
    it("is a no-op when AICE_ENV_PROFILE is unset", () => {
      // No env vars set at all — would otherwise fail multiple checks.
      expect(() => validateProdComposeEnv()).not.toThrow();
    });

    it("is a no-op when AICE_ENV_PROFILE is some other value", () => {
      process.env[PROD_COMPOSE_ENV_VAR] = "k8s";
      // No EXPECTED_ORIGIN, localhost DSN — would fail under prod-compose
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/db";
      expect(() => validateProdComposeEnv()).not.toThrow();
    });

    it("runs when AICE_ENV_PROFILE=prod-compose", () => {
      process.env[PROD_COMPOSE_ENV_VAR] = PROD_COMPOSE_PROFILE_MARKER;
      // Missing EXPECTED_ORIGIN is enough to trip the guard.
      expect(() => validateProdComposeEnv()).toThrow(
        /EXPECTED_ORIGIN is required/,
      );
    });

    it("isProdComposeProfile reflects the env var", () => {
      expect(isProdComposeProfile()).toBe(false);
      process.env[PROD_COMPOSE_ENV_VAR] = PROD_COMPOSE_PROFILE_MARKER;
      expect(isProdComposeProfile()).toBe(true);
      process.env[PROD_COMPOSE_ENV_VAR] = "  prod-compose  ";
      expect(isProdComposeProfile()).toBe(true);
    });
  });

  // ── EXPECTED_ORIGIN ────────────────────────────────────────────

  describe("EXPECTED_ORIGIN", () => {
    beforeEach(() => {
      process.env[PROD_COMPOSE_ENV_VAR] = PROD_COMPOSE_PROFILE_MARKER;
      // Use valid DSNs so EXPECTED_ORIGIN is the only failing check.
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@postgres:5432/auth_db";
      process.env.DATABASE_ADMIN_URL =
        "postgres://postgres:postgres@postgres:5432/postgres";
      process.env.AUDIT_DATABASE_URL =
        "postgres://audit_writer:changeme@postgres:5432/audit_db";
    });

    it("throws when unset", () => {
      expect(() => validateProdComposeEnv()).toThrow(
        /EXPECTED_ORIGIN is required/,
      );
    });

    it("throws when blank", () => {
      process.env.EXPECTED_ORIGIN = "   ";
      expect(() => validateProdComposeEnv()).toThrow(
        /EXPECTED_ORIGIN is required/,
      );
    });

    it("throws when set to a non-URL value", () => {
      process.env.EXPECTED_ORIGIN = "your.host";
      expect(() => validateProdComposeEnv()).toThrow(
        /EXPECTED_ORIGIN=.*is not a valid origin/,
      );
    });

    it("throws when value has a path", () => {
      process.env.EXPECTED_ORIGIN = "https://host/app";
      expect(() => validateProdComposeEnv()).toThrow(/is not a valid origin/);
    });

    it("throws when value has a query string", () => {
      process.env.EXPECTED_ORIGIN = "https://host?x=1";
      expect(() => validateProdComposeEnv()).toThrow(/is not a valid origin/);
    });

    it("throws when value has a fragment", () => {
      process.env.EXPECTED_ORIGIN = "https://host#frag";
      expect(() => validateProdComposeEnv()).toThrow(/is not a valid origin/);
    });

    it.each([
      ["ftp://host"],
      ["ws://host"],
      ["wss://host:9443"],
    ])("throws when value has a non-HTTP(S) scheme (%s)", (value) => {
      process.env.EXPECTED_ORIGIN = value;
      expect(() => validateProdComposeEnv()).toThrow(/is not a valid origin/);
    });

    it.each([
      ["https://host", "https://host"],
      ["https://host:9443", "https://host:9443"],
      ["HTTPS://Host.Example.com/", "HTTPS://Host.Example.com/"],
    ])("accepts %s", (_label, value) => {
      process.env.EXPECTED_ORIGIN = value;
      expect(() => validateProdComposeEnv()).not.toThrow();
    });
  });

  // ── PostgreSQL DSN guard ────────────────────────────────────────

  describe("PostgreSQL DSN guard", () => {
    beforeEach(() => {
      process.env[PROD_COMPOSE_ENV_VAR] = PROD_COMPOSE_PROFILE_MARKER;
      process.env.EXPECTED_ORIGIN = "https://host:9443";
    });

    it.each(
      POSTGRES_DSN_ENV_VARS,
    )("rejects %s pointing at localhost", (envVar) => {
      process.env[envVar] = "postgres://postgres@localhost:5432/db";
      expect(() => validateProdComposeEnv()).toThrow(
        new RegExp(`${envVar} points at \\\`localhost\\\`.*container-local`),
      );
    });

    it.each(
      POSTGRES_DSN_ENV_VARS,
    )("rejects %s pointing at 127.0.0.1", (envVar) => {
      process.env[envVar] = "postgres://postgres@127.0.0.1:5432/db";
      expect(() => validateProdComposeEnv()).toThrow(
        new RegExp(`${envVar} points at \\\`127.0.0.1\\\`.*container-local`),
      );
    });

    it.each(POSTGRES_DSN_ENV_VARS)("rejects %s pointing at ::1", (envVar) => {
      process.env[envVar] = "postgres://postgres@[::1]:5432/db";
      expect(() => validateProdComposeEnv()).toThrow(
        new RegExp(`${envVar} points at .*container-local`),
      );
    });

    it("accepts compose-network hostnames", () => {
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@postgres:5432/auth_db";
      process.env.DATABASE_ADMIN_URL =
        "postgres://postgres:postgres@postgres:5432/postgres";
      process.env.AUDIT_DATABASE_URL =
        "postgres://audit_writer:changeme@postgres:5432/audit_db";
      expect(() => validateProdComposeEnv()).not.toThrow();
    });

    it("aggregates multiple DSN failures into one error", () => {
      process.env.DATABASE_URL = "postgres://postgres@localhost:5432/auth_db";
      process.env.AUDIT_DATABASE_URL =
        "postgres://audit_writer@127.0.0.1:5432/audit_db";
      const err = (() => {
        try {
          validateProdComposeEnv();
        } catch (e) {
          return e as Error;
        }
        return null;
      })();
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/DATABASE_URL/);
      expect(err?.message).toMatch(/AUDIT_DATABASE_URL/);
    });

    it("ignores unset DSNs (caller may not configure every URL)", () => {
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@postgres:5432/auth_db";
      // DATABASE_ADMIN_URL / AUDIT_DATABASE_URL unset — should not flag.
      expect(() => validateProdComposeEnv()).not.toThrow();
    });

    it("findContainerLocalDsnHostnames lists each offender once", () => {
      const env = {
        DATABASE_URL: "postgres://postgres@localhost:5432/auth_db",
        DATABASE_ADMIN_URL: "postgres://postgres@127.0.0.1:5432/postgres",
        AUDIT_DATABASE_URL: "postgres://audit@[::1]:5432/audit_db",
      } as unknown as NodeJS.ProcessEnv;
      const issues = findContainerLocalDsnHostnames(env);
      expect(issues.map((i) => i.envVar).sort()).toEqual([
        "AUDIT_DATABASE_URL",
        "DATABASE_ADMIN_URL",
        "DATABASE_URL",
      ]);
    });
  });

  // ── error shape ────────────────────────────────────────────────

  it("aggregates EXPECTED_ORIGIN and DSN problems into one error", () => {
    process.env[PROD_COMPOSE_ENV_VAR] = PROD_COMPOSE_PROFILE_MARKER;
    process.env.DATABASE_URL = "postgres://postgres@localhost:5432/auth_db";
    try {
      validateProdComposeEnv();
      throw new Error("expected validateProdComposeEnv to throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/EXPECTED_ORIGIN is required/);
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).toMatch(/\.env\.example\.prod/);
    }
  });
});
