export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupMigrations } = await import("@/lib/db/migrate");
    const { bootstrapAdminAccount } = await import("@/lib/auth/bootstrap");
    const {
      loadSigningKeys,
      getPublicKeyData,
      autoGenerateJwtSigningKeyIfMissing,
    } = await import("@/lib/auth/jwt-keys");
    const { initStatelessKeys } = await import(
      "@/lib/auth/jwt-verify-stateless"
    );

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );
    const { installMtlsSighupHandler } = await import(
      "@/lib/instrumentation/mtls-sighup"
    );

    await runStartupMigrations();
    await bootstrapAdminAccount();

    // First-boot convenience: when the operator opts in with
    // JWT_SIGNING_KEY_AUTOGEN=1 and is not pointing at an externally
    // managed key via JWT_SIGNING_KEY_FILE, generate an ES256 key on
    // disk before loadSigningKeys() runs. Idempotent — re-boots load
    // the existing key.
    if (
      isTruthyEnv(process.env.JWT_SIGNING_KEY_AUTOGEN) &&
      !process.env.JWT_SIGNING_KEY_FILE
    ) {
      await autoGenerateJwtSigningKeyIfMissing();
    }

    await loadSigningKeys();
    await initStatelessKeys(getPublicKeyData());
    await emergencyMfaReset();
    await installMtlsSighupHandler();

    // Surface a warning when the Aimer context-token signing key file
    // exists but its mode drifted from 0600 (#437).  The admin page
    // also alerts on this; the boot-time log gives operators an
    // earlier signal in container logs.
    const { checkFilePermissionsOk, aimerSigningKeyFilePath } = await import(
      "@/lib/aimer/signing-key"
    );
    const aimerKeyPerm = checkFilePermissionsOk();
    if (!aimerKeyPerm.ok) {
      console.warn(
        `[aimer-signing-key] On-disk file ${aimerSigningKeyFilePath()} has mode ${aimerKeyPerm.observed} instead of 0600. Restore correct permissions before continuing.`,
      );
    }
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}
