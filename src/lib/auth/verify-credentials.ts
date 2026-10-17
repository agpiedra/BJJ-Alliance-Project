import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export interface VerifiedUser {
  id: string;
  email: string;
  name: string;
  /**
   * Read in the SAME query as the password hash that was just verified, so it is the version that belongs to that
   * password. A password reset that commits after this read cannot hand this login its new version: this login keeps
   * the old one and is refused as stale (src/lib/auth/session-credentials.ts).
   */
  credentialsVersion: number;
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, active: true, passwordHash: true, credentialsVersion: true },
  });
  if (!user || !user.active) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, name: user.email, credentialsVersion: user.credentialsVersion };
}
