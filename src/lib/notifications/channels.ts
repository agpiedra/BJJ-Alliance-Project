import { Resend } from "resend";
import { requireEnv } from "@/lib/env";
import { InAppChannel } from "@/lib/notifications/in-app-channel";
import { EmailChannel } from "@/lib/notifications/email-channel";
import type { NotificationChannel } from "@/lib/notifications/types";

/**
 * Every channel a notification should be dispatched through — Task 3/4's
 * trigger sites import this instead of each reconstructing the channel list.
 *
 * A module-level constant (not a factory function) built at import time,
 * matching `src/lib/prisma.ts`'s own precedent of failing fast via
 * `requireEnv` at module load rather than lazily. This module is only ever
 * imported from real server-side dispatch call sites — `email-channel.test.ts`
 * imports `EmailChannel` directly and injects a fake Resend client, so it
 * never triggers this module's `requireEnv("RESEND_API_KEY")`.
 */
export const ALL_CHANNELS: NotificationChannel[] = [
  new InAppChannel(),
  new EmailChannel(new Resend(requireEnv("RESEND_API_KEY"))),
];
