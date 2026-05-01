import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/auth_db";
const DATABASE_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

const authClient = new pg.Client({ connectionString: DATABASE_URL });
const adminClient = new pg.Client({ connectionString: DATABASE_ADMIN_URL });

await authClient.connect();
await adminClient.connect();

try {
  const { rows } = await authClient.query(
    `SELECT id, database_name
       FROM customers
      WHERE status IN ('active', 'provisioning')`,
  );

  for (const row of rows) {
    const exists = await adminClient.query(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [row.database_name],
    );
    if (exists.rows[0]?.exists) continue;

    await authClient.query(
      "DELETE FROM account_customer WHERE customer_id = $1",
      [row.id],
    );
    await authClient.query("DELETE FROM customers WHERE id = $1", [row.id]);
    console.log(
      `[e2e] Removed orphaned customer row ${row.id} (${row.database_name}) with missing backing DB`,
    );
  }
} finally {
  await authClient.end();
  await adminClient.end();
}
