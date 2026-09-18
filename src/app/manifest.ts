import type { MetadataRoute } from "next";
import { PLATFORM_NAME } from "@/lib/platform";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — replaces the static
 * `public/manifest.json`, which hardcoded "Alliance Jiu-Jitsu Costa Rica" /
 * "Alliance BJJ" as the installed-PWA name for every organization on the
 * platform. A static JSON asset can't import a shared TS constant, so it
 * was a second place that would silently drift from `PLATFORM_NAME` the
 * day the real product name is chosen — this file-convention route can,
 * making it the only place besides `platform.ts` itself.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PLATFORM_NAME,
    short_name: PLATFORM_NAME,
    start_url: ".",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#171717",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
