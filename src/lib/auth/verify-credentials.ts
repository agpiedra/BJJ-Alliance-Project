import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/** bcrypt cost 12 (the cost hashSecret uses) of a discarded random value; nothing can verify against it. */
const DUMMY_PASSWORD_HASH = "$2b$12$vVLs73l3HsLF/yYiIxchbeNa5IZlxhKAKZ0KoqVKLguLVstDxTiVC";

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
  if (!user || !user.active) {
    // Same-cost compare, result discarded, so a missing or inactive account does not answer measurably faster than an
    // active one with a wrong password. This narrows a timing difference; it is not a proof of equivalence.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, name: user.email, credentialsVersion: user.credentialsVersion };
}
