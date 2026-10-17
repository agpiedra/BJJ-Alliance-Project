import { after } from "next/server";

/**
 * Runs `task` after the response has been sent, through Next's `after()`. Returns false when it could not be
 * scheduled (for example when called outside a request scope), so the caller can treat the work as never attempted.
 *
 * NOT a durable queue: the task runs in the same server instance after the response. If that instance stops, crashes
 * or hits its time limit, the task may not run or may stop partway, and nothing retries it.
 *
 * The task must handle its own errors; anything it throws is caught here and dropped, never logged, because an
 * arbitrary error object can carry secrets.
 */
export function scheduleAfterResponse(task: () => Promise<void>): boolean {
  try {
    after(async () => {
      try {
        await task();
      } catch {
        // The task is responsible for its own reporting (see its own catch blocks).
      }
    });
    return true;
  } catch {
    return false;
  }
}
