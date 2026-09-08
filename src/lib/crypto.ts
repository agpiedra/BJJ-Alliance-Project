import bcrypt from "bcryptjs";
import { createHmac, randomBytes } from "node:crypto";

const SALT_ROUNDS = 12;

export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, SALT_ROUNDS);
}

/**
 * Deterministic keyed digest for secrets that must be looked up by value
 * (Academy.kioskTokenHash, Student.codeHash) — bcrypt's random salt would
 * make the DB-level @unique constraint unenforceable and turn every lookup
 * into an O(n) scan. Irreversible without the pepper, which lives in env
 * (CODE_PEPPER) and is never stored in the database.
 */
export function digestLookupSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function generateRandomToken(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}
