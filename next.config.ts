import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // This limit is GLOBAL — every Server Action in the app, not just
      // branding's, accepts up to this many bytes. Next's own default
      // (1 MB) sits below what a real, unedited phone photo weighs, which
      // is what first surfaced this: a director picking a full-resolution
      // logo photo hit Next's own hard body-size rejection (a raw 500,
      // "Body exceeded 1 MB limit") before uploadBrandingLogo's own
      // graceful `tooLarge` check (validate-logo.ts's real 512 KB business
      // rule) ever ran.
      //
      // The fix is NOT a bigger global limit — that would let every Server
      // Action in the app, including the unauthenticated public
      // registration and student signup actions, accept far more than they
      // need. The real fix is client-side: logo-uploader.tsx checks
      // file.size against the same 512 KB rule (via logo-constraints.ts)
      // before the browser ever sends the file, so an oversized photo never
      // reaches this limit at all in the normal case. This value only needs
      // to comfortably cover one legitimate ≤512 KB upload plus multipart
      // overhead — confirmed current per Next's own docs (still
      // experimental.serverActions.bodySizeLimit, not moved), whose own
      // example uses this same "2mb" value.
      bodySizeLimit: "2mb",
    },
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
