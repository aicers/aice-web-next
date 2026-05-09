import "server-only";

import { getCustomerPool } from "./customer-db";
import type {
  PolicyCreateInput,
  PolicyUpdateInput,
  TriagePolicyRow,
} from "./types";

const POLICY_COLUMNS =
  "id, name, packet_attr, confidence, response, created_at, updated_at";

const PG_UNIQUE_VIOLATION = "23505";

export class TriagePolicyNameConflictError extends Error {
  constructor(name: string) {
    super(`Policy name '${name}' is already in use`);
    this.name = "TriagePolicyNameConflictError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

export async function listPolicies(
  customerId: number,
): Promise<TriagePolicyRow[]> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<TriagePolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM triage_policy ORDER BY id`,
  );
  return rows;
}

export async function getPolicy(
  customerId: number,
  id: number,
): Promise<TriagePolicyRow | null> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<TriagePolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM triage_policy WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createPolicy(
  customerId: number,
  input: PolicyCreateInput,
): Promise<TriagePolicyRow> {
  const pool = await getCustomerPool(customerId);
  try {
    const { rows } = await pool.query<TriagePolicyRow>(
      `INSERT INTO triage_policy (name, packet_attr, confidence, response)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
       RETURNING ${POLICY_COLUMNS}`,
      [
        input.name,
        JSON.stringify(input.packet_attr ?? []),
        JSON.stringify(input.confidence ?? []),
        JSON.stringify(input.response ?? []),
      ],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TriagePolicyNameConflictError(input.name);
    }
    throw err;
  }
}

export async function updatePolicy(
  customerId: number,
  id: number,
  input: PolicyUpdateInput,
): Promise<TriagePolicyRow | null> {
  const pool = await getCustomerPool(customerId);
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(input.name);
  }
  if (input.packet_attr !== undefined) {
    sets.push(`packet_attr = $${idx++}::jsonb`);
    params.push(JSON.stringify(input.packet_attr));
  }
  if (input.confidence !== undefined) {
    sets.push(`confidence = $${idx++}::jsonb`);
    params.push(JSON.stringify(input.confidence));
  }
  if (input.response !== undefined) {
    sets.push(`response = $${idx++}::jsonb`);
    params.push(JSON.stringify(input.response));
  }

  if (sets.length === 0) {
    // No-op update: just return the current row.
    return getPolicy(customerId, id);
  }

  sets.push("updated_at = NOW()");
  params.push(id);

  try {
    const { rows } = await pool.query<TriagePolicyRow>(
      `UPDATE triage_policy SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${POLICY_COLUMNS}`,
      params,
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TriagePolicyNameConflictError(String(input.name ?? ""));
    }
    throw err;
  }
}

export async function deletePolicy(
  customerId: number,
  id: number,
): Promise<boolean> {
  const pool = await getCustomerPool(customerId);
  const result = await pool.query("DELETE FROM triage_policy WHERE id = $1", [
    id,
  ]);
  return (result.rowCount ?? 0) > 0;
}
