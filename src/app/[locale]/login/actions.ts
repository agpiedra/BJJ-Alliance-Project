"use server";

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { ActionState } from "@/lib/action-state";
import { sanitizeCallbackUrl } from "@/lib/callback-url";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(
  locale: string,
  callbackUrl: string | undefined,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const safeCallbackUrl = sanitizeCallbackUrl(callbackUrl);

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "invalidCredentials", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "invalidCredentials" };
    }
    throw error;
  }

  if (safeCallbackUrl) {
    redirect(safeCallbackUrl);
  }

  // No explicit callbackUrl: pick a role-appropriate default landing page.
  // `signIn(..., { redirect: false })` doesn't hand the role back directly,
  // and we deliberately don't trust anything client-submitted for this —
  // query by the email that JUST successfully authenticated above (not a
  // client-submitted role) to decide where it lands.
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { role: true },
  });

  redirect(user?.role === "STUDENT" ? `/${locale}/portal` : `/${locale}/dashboard`);
}
