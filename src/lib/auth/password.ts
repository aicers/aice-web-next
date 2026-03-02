import "server-only";

import argon2 from "argon2";

/**
 * Hash a plaintext password using Argon2id.
 * Returns a PHC-format string: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

/**
 * Verify a plaintext password against an Argon2id PHC string.
 */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(hash, password);
}
