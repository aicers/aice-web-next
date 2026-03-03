export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupMigrations } = await import("@/lib/db/migrate");
    const { bootstrapAdminAccount } = await import("@/lib/auth/bootstrap");
    const { loadSigningKeys, getPublicKeyData } = await import(
      "@/lib/auth/jwt-keys"
    );
    const { initStatelessKeys } = await import(
      "@/lib/auth/jwt-verify-stateless"
    );

    await runStartupMigrations();
    await bootstrapAdminAccount();
    await loadSigningKeys();
    await initStatelessKeys(getPublicKeyData());
  }
}
