import { NextResponse } from "next/server";
import { requireEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/auth/secrets-match";
import { emailPolicyStatus } from "@/lib/email/recipient-policy";

/**
 * Which email recipient policy this deployment enforces (docs/EMAIL_RECIPIENT_POLICY.md), behind the same shared secret
 * as `/api/health/jobs`. Read-only: no database, no Resend client, no send. The body holds fixed values, a count and a
 * fingerprint keyed with this secret — never an address, a domain, a key or a raw setting value.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = requireEnv("CRON_SECRET");
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(emailPolicyStatus(secret), { status: 200, headers: { "Cache-Control": "no-store" } });
}
