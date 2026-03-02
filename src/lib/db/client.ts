import "server-only";

import pg from "pg";

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing environment variable: DATABASE_URL");
  }

  pool = new pg.Pool({ connectionString });
  return pool;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const result = await getPool().query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount };
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function connectTo(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export async function end(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function resetPool(): void {
  pool = null;
}
