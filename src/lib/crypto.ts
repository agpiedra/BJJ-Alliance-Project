import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const SALT_ROUNDS = 12;

export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, SALT_ROUNDS);
}

export function generateRandomToken(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}
