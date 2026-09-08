import { prisma } from "@/lib/prisma";
import { SignupForm } from "./signup-form";

// The academy list is queried live, not baked into the build: unlike
// force-static routes here, this page reads a DB table an admin could
// change without a redeploy, so it must not be frozen at build time.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const academies = await prisma.academy.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  return <SignupForm academies={academies} />;
}
