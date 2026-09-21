import { BrandBanner } from "@/components/brand/brand-banner";
import { describeInvitation } from "@/lib/staff/describe-invitation";
import { AcceptInvitationForm } from "./accept-invitation-form";

// Depends on the token in the query string and on the invitation's live state
// (used, revoked, expired) — never statically frozen.
export const dynamic = "force-dynamic";

/**
 * A server component so the SERVER decides what the form asks for: a brand-new
 * account (or an unaccepted owner placeholder) chooses a password; someone who
 * already has an account is only offered to join, and is never asked for — nor
 * can this link change — the password they already have.
 */
export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  const { token = "" } = await searchParams;
  const summary = await describeInvitation(token);

  return (
    <>
      <BrandBanner />
      <AcceptInvitationForm locale={locale} token={token} summary={summary} />
    </>
  );
}
