import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Next's own default (1 MB) sits BELOW what a real, unedited phone
      // photo weighs — a director picking a full-resolution logo photo hit
      // Next's own hard body-size rejection (a raw 500, "Body exceeded 1 MB
      // limit", the whole page crashing into the generic error boundary)
      // before uploadBrandingLogo's own graceful `tooLarge` check
      // (src/lib/branding/validate-logo.ts's real 512 KB business rule)
      // ever got a chance to run. Found only by driving a real multipart
      // upload through this action's real HTTP path — the mocked
      // integration test constructs a 600 KB buffer and calls the action
      // function directly, which never touches Next's own body parser at
      // all. Set generously above any realistic phone-photo size so the
      // app's own 512 KB rule — not Next's request-parsing limit — is what
      // a director actually sees for every plausible oversized upload.
      bodySizeLimit: "10mb",
    },
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
