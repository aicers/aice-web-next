export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupMigrations } = await import("@/lib/db/migrate");
    const { bootstrapAdminAccount } = await import("@/lib/auth/bootstrap");

    await runStartupMigrations();
    await bootstrapAdminAccount();
  }
}
