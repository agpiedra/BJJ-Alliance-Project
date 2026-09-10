import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailChannel, type ResendClient } from "@/lib/notifications/email-channel";
import type { Recipient, RenderedMessage } from "@/lib/notifications/types";

const recipient: Recipient = { userId: "user-1", email: "student@example.com", locale: "en" };
const message: RenderedMessage = {
  type: "NEW_SIGNUP",
  title: "New signup",
  body: "Line one.\nLine two.",
};

beforeEach(() => {
  vi.stubEnv("EMAIL_FROM", "Alliance BJJ <notifications@resend.dev>");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("EmailChannel", () => {
  it("returns { success: true } when Resend reports success", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email-1" }, error: null });
    const fakeClient: ResendClient = { emails: { send } };

    const result = await new EmailChannel(fakeClient).send(recipient, message);

    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledWith({
      from: "Alliance BJJ <notifications@resend.dev>",
      to: recipient.email,
      subject: message.title,
      html: expect.any(String),
    });
  });

  it("wraps each line of the body in its own <p> tag", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email-1" }, error: null });
    const fakeClient: ResendClient = { emails: { send } };

    await new EmailChannel(fakeClient).send(recipient, message);

    const { html } = send.mock.calls[0][0];
    expect(html).toBe("<p>Line one.</p><p>Line two.</p>");
  });

  it("returns { success: false, error } when Resend reports a failure without throwing", async () => {
    const send = vi.fn().mockResolvedValue({ data: null, error: { message: "Invalid API key" } });
    const fakeClient: ResendClient = { emails: { send } };

    const result = await new EmailChannel(fakeClient).send(recipient, message);

    expect(result).toEqual({ success: false, error: "Invalid API key" });
  });

  it("catches a thrown error (e.g. network failure) instead of propagating it", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network failure"));
    const fakeClient: ResendClient = { emails: { send } };

    const result = await new EmailChannel(fakeClient).send(recipient, message);

    expect(result).toEqual({ success: false, error: "network failure" });
  });

  it("never lets send() throw, even for a non-Error rejection", async () => {
    const send = vi.fn().mockRejectedValue("some string rejection");
    const fakeClient: ResendClient = { emails: { send } };

    await expect(new EmailChannel(fakeClient).send(recipient, message)).resolves.toEqual({
      success: false,
      error: "some string rejection",
    });
  });

  it("does not support inbound replies", () => {
    const fakeClient: ResendClient = { emails: { send: vi.fn() } };
    expect(new EmailChannel(fakeClient).supportsInboundReplies).toBe(false);
  });
});
