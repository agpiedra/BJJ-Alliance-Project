import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export interface VerifiedUser {
  id: string;
  email: string;
  role: string;
  name: string;
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, role: user.role, name: user.email };
}
