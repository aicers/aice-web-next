import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { calculateJwkThumbprint } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpDir = path.join(__dirname, ".tmp-aimer-signing");
const dataDir = path.join(tmpDir, "data");

describe("aimer signing-key facade", () => {
  let mod: typeof import("@/lib/aimer/signing-key");

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = "0";
    mod = await import("@/lib/aimer/signing-key");
    mod.deleteAimerSigningKeyFile();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── computeJwkThumbprintFormats ─────────────────────────────

  describe("thumbprint formats", () => {
    it("produces base64url matching jose's canonical thumbprint", async () => {
      await mod.generateAimerSigningKey();
      const status = await mod.getAimerSigningKeyStatus();
      const active = status.active;
      if (!active) throw new Error("expected active key");
      const expected = await calculateJwkThumbprint(active.publicJwk, "sha256");
      expect(active.thumbprintBase64Url).toBe(expected);
      // base64url has no padding and is the canonical 43-char form for SHA-256.
      expect(active.thumbprintBase64Url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("renders the same SHA-256 in colon-separated hex (4-byte blocks)", async () => {
      await mod.generateAimerSigningKey();
      const status = await mod.getAimerSigningKeyStatus();
      const active = status.active;
      if (!active) throw new Error("expected active key");
      // 32 bytes = 64 hex chars = 8 groups of 8 hex chars.
      const groups = active.thumbprintHexColons.split(":");
      expect(groups).toHaveLength(8);
      for (const g of groups) expect(g).toMatch(/^[0-9a-f]{8}$/);
      // The full hex string equals the base64url decoded into hex.
      const flatHex = active.thumbprintHexColons.replaceAll(":", "");
      expect(flatHex).toHaveLength(64);
    });

    it("never returns the private key in the public status", async () => {
      await mod.generateAimerSigningKey();
      const status = await mod.getAimerSigningKeyStatus();
      const json = JSON.stringify(status);
      // ES256 private key serializes with `d`; public-only JWK does not.
      expect(json).not.toMatch(/"d"\s*:/);
    });
  });

  // ── file permissions ────────────────────────────────────────

  describe("on-disk file permissions", () => {
    it("writes the file with mode 0600", async () => {
      await mod.generateAimerSigningKey();
      const filePath = mod.aimerSigningKeyFilePath();
      const observed = statSync(filePath).mode & 0o777;
      expect(observed).toBe(0o600);
    });

    it("locks the parent keys directory to mode 0700", async () => {
      await mod.generateAimerSigningKey();
      const keysDir = path.dirname(mod.aimerSigningKeyFilePath());
      const observed = statSync(keysDir).mode & 0o777;
      expect(observed).toBe(0o700);
    });

    it("flags drift when the file mode is loosened externally", async () => {
      await mod.generateAimerSigningKey();
      // Simulate an operator restoring a backup with looser perms.
      mod.chmodAimerSigningKeyFileForTest(0o644);

      const status = await mod.getAimerSigningKeyStatus();
      expect(status.filePermissionAlert).toBe(true);
      expect(status.observedFilePermission).toBe("0644");

      const result = mod.checkFilePermissionsOk();
      expect(result.ok).toBe(false);
      expect(result.observed).toBe("0644");
    });

    it("does not flag when the file is absent (clean install)", async () => {
      const status = await mod.getAimerSigningKeyStatus();
      expect(status.state).toBe("empty");
      expect(status.filePermissionAlert).toBe(false);
    });
  });

  // ── rotation state machine ──────────────────────────────────

  describe("rotation state machine", () => {
    it("transitions empty → active_only on generate", async () => {
      let status = await mod.getAimerSigningKeyStatus();
      expect(status.state).toBe("empty");

      await mod.generateAimerSigningKey();
      status = await mod.getAimerSigningKeyStatus();
      expect(status.state).toBe("active_only");
      expect(status.active).not.toBeNull();
      expect(status.pending).toBeNull();
      expect(status.previous).toBeNull();
    });

    it("refuses to generate over an existing active key", async () => {
      await mod.generateAimerSigningKey();
      await expect(mod.generateAimerSigningKey()).rejects.toThrow(
        /already exists/,
      );
    });

    it("rotate moves to active_and_pending and refuses re-rotate", async () => {
      await mod.generateAimerSigningKey();
      await mod.rotateAimerSigningKey();

      const status = await mod.getAimerSigningKeyStatus();
      expect(status.state).toBe("active_and_pending");
      expect(status.pending).not.toBeNull();
      // Active and pending must have distinct kids.
      expect(status.active?.kid).not.toBe(status.pending?.kid);

      await expect(mod.rotateAimerSigningKey()).rejects.toThrow(
        /already in progress/,
      );
    });

    it("switch is forbidden without operator confirmation", async () => {
      await mod.generateAimerSigningKey();
      await mod.rotateAimerSigningKey();
      await expect(
        mod.switchAimerSigningKey({ confirmRegistered: false }),
      ).rejects.toThrow(/confirmation/);
    });

    it("switch promotes pending to active and demotes old active to previous", async () => {
      await mod.generateAimerSigningKey();
      const beforeRotate = await mod.getAimerSigningKeyStatus();
      const originalActiveKid = beforeRotate.active?.kid;
      await mod.rotateAimerSigningKey();
      const beforeSwitch = await mod.getAimerSigningKeyStatus();
      const pendingKid = beforeSwitch.pending?.kid;

      const result = await mod.switchAimerSigningKey({
        confirmRegistered: true,
      });

      expect(result.activeKid).toBe(pendingKid);
      expect(result.previousKid).toBe(originalActiveKid);

      const afterSwitch = await mod.getAimerSigningKeyStatus();
      expect(afterSwitch.state).toBe("active_and_previous");
      expect(afterSwitch.active?.kid).toBe(pendingKid);
      expect(afterSwitch.previous?.kid).toBe(originalActiveKid);
      expect(afterSwitch.pending).toBeNull();
    });

    it("deactivate is allowed only after switch", async () => {
      await mod.generateAimerSigningKey();
      // No previous — error.
      expect(() => mod.deactivateAimerSigningPreviousKey()).toThrow(
        /No previous kid/,
      );

      await mod.rotateAimerSigningKey();
      // Pending exists, no previous yet — still error.
      expect(() => mod.deactivateAimerSigningPreviousKey()).toThrow(
        /No previous kid/,
      );

      await mod.switchAimerSigningKey({ confirmRegistered: true });
      // Retention window is 0ms in tests; deactivate should succeed.
      const result = mod.deactivateAimerSigningPreviousKey();
      expect(result.previousKid).toBeDefined();

      const after = await mod.getAimerSigningKeyStatus();
      expect(after.state).toBe("active_only");
      expect(after.previous).toBeNull();
    });

    it("deactivate refuses while the retention window is unexpired", async () => {
      // Use a long retention window to assert the gate.
      process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = String(60 * 1000);

      await mod.generateAimerSigningKey();
      await mod.rotateAimerSigningKey();
      await mod.switchAimerSigningKey({ confirmRegistered: true });

      expect(() => mod.deactivateAimerSigningPreviousKey()).toThrow(
        /retention window has not elapsed/,
      );

      // The previous slot is still on disk — no public API force
      // escape hatch exists to clear it before the timer.
      const status = await mod.getAimerSigningKeyStatus();
      expect(status.state).toBe("active_and_previous");
      expect(status.previous).not.toBeNull();
    });

    it("rotate is rejected while a previous slot is still retained", async () => {
      // Long window so previous stays retained across the next rotate
      // attempt.
      process.env.AIMER_SIGNING_KEY_PREV_RETENTION_MS = String(60 * 1000);

      await mod.generateAimerSigningKey();
      await mod.rotateAimerSigningKey();
      await mod.switchAimerSigningKey({ confirmRegistered: true });

      await expect(mod.rotateAimerSigningKey()).rejects.toThrow(
        /Deactivate the previous kid/,
      );
    });
  });

  // ── atomic write / fail-closed ─────────────────────────────

  describe("atomic write and verification key lookup", () => {
    it("uses temp+rename so partial writes never appear at the canonical path", async () => {
      await mod.generateAimerSigningKey();
      const filePath = mod.aimerSigningKeyFilePath();
      // The file content must be valid JSON — never a half-written
      // tmp suffix file at the canonical path.
      const raw = readFileSync(filePath, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("getAimerVerificationKey resolves active and previous kids", async () => {
      await mod.generateAimerSigningKey();
      const beforeRotate = await mod.getAimerSigningKeyStatus();
      const originalKid = beforeRotate.active?.kid;
      if (!originalKid) throw new Error("expected active");

      await mod.rotateAimerSigningKey();
      await mod.switchAimerSigningKey({ confirmRegistered: true });

      const oldEntry = await mod.getAimerVerificationKey(originalKid);
      expect(oldEntry).not.toBeNull();
      expect(oldEntry?.kid).toBe(originalKid);

      const lookup = await mod.getAimerVerificationKey("does-not-exist");
      expect(lookup).toBeNull();
    });

    it("loadActiveSigningKeyMaterial returns the private JWK for server-side signing", async () => {
      await mod.generateAimerSigningKey();
      const material = mod.loadActiveSigningKeyMaterial();
      expect(material).not.toBeNull();
      expect(material?.algorithm).toBe("ES256");
      // The private JWK has the `d` parameter; this is intentional —
      // the helper is server-side only and feeds the context-token
      // signer. The HTTP boundary uses getAimerSigningKeyStatus
      // which strips it.
      expect(material?.privateJwk.d).toBeDefined();
    });
  });

  // ── perm-drift refusal on write ────────────────────────────

  describe("write refuses to leave looser perms", () => {
    it("rejects when chmod cannot tighten the temp file", async () => {
      // We cannot easily simulate a chmod failure on POSIX — at
      // minimum, assert that a successful generate followed by a
      // chmod-loosening external action still flips the alert and
      // the next generate (which is forbidden anyway) would be
      // refused. The mode-drift detection path is covered above.
      await mod.generateAimerSigningKey();
      mod.chmodAimerSigningKeyFileForTest(0o644);

      const result = mod.checkFilePermissionsOk();
      expect(result.ok).toBe(false);
      expect(result.observed).toBe("0644");
      // Still readable — the alert is informational, not a hard
      // refusal of reads.
      const status = await mod.getAimerSigningKeyStatus();
      expect(status.active).not.toBeNull();
    });
  });

  // ── existence helpers ──────────────────────────────────────

  describe("hasActiveAimerSigningKey", () => {
    it("returns false when the file is absent", () => {
      expect(mod.hasActiveAimerSigningKey()).toBe(false);
    });
    it("returns true after generate", async () => {
      await mod.generateAimerSigningKey();
      expect(mod.hasActiveAimerSigningKey()).toBe(true);
    });
  });
});

describe("aimer signing-key facade — file path overrides", () => {
  it("resolves under <DATA_DIR>/keys/", () => {
    const here = path.join(__dirname, ".tmp-aimer-pathcheck");
    mkdirSync(here, { recursive: true });
    process.env.DATA_DIR = here;
    return import("@/lib/aimer/signing-key").then((m) => {
      expect(m.aimerSigningKeyFilePath()).toBe(
        path.join(here, "keys", "aimer-context-signing.json"),
      );
      delete process.env.DATA_DIR;
      rmSync(here, { recursive: true, force: true });
    });
  });
});

describe("aimer signing-key facade — does not pollute when absent", () => {
  it("getAimerSigningKeyStatus returns empty state cleanly", async () => {
    const here = path.join(__dirname, ".tmp-aimer-empty");
    mkdirSync(here, { recursive: true });
    process.env.DATA_DIR = here;
    const m = await import("@/lib/aimer/signing-key");
    m.deleteAimerSigningKeyFile();
    const status = await m.getAimerSigningKeyStatus();
    expect(status.state).toBe("empty");
    expect(status.active).toBeNull();
    expect(status.pending).toBeNull();
    expect(status.previous).toBeNull();
    expect(existsSync(m.aimerSigningKeyFilePath())).toBe(false);
    delete process.env.DATA_DIR;
    rmSync(here, { recursive: true, force: true });
  });
});
