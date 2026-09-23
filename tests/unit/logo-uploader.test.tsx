/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import type { ActionState } from "../../src/lib/action-state";

const { LogoUploader } = await import("../../src/components/branding/logo-uploader");

function png(bytes = 10): File {
  return new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderUploader(overrides: {
  uploadAction?: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
  removeAction?: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
  logoUrl?: string | null;
} = {}) {
  const uploadAction = overrides.uploadAction ?? (async () => ({ ok: true }));
  const removeAction = overrides.removeAction ?? (async () => ({ ok: true }));
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LogoUploader
        organizationId="org-1"
        logoUrl={overrides.logoUrl ?? null}
        displayName="Test Academy"
        previewBackground="#111827"
        uploadAction={uploadAction}
        removeAction={removeAction}
      />
    </NextIntlClientProvider>,
  );
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("LogoUploader", () => {
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURLMock = vi.fn(() => "blob:mock-url");
    revokeObjectURLMock = vi.fn();
    // jsdom doesn't implement these.
    (global.URL as unknown as { createObjectURL: typeof createObjectURLMock }).createObjectURL = createObjectURLMock;
    (global.URL as unknown as { revokeObjectURL: typeof revokeObjectURLMock }).revokeObjectURL = revokeObjectURLMock;
  });

  afterEach(cleanup);

  it("REQUIRED: an empty submission renders the server's distinct error, not the generic fallback", async () => {
    const uploadAction = vi.fn(async () => ({ error: "invalid", fieldErrors: { logo: ["required"] } }) as ActionState);
    renderUploader({ uploadAction });

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByText("Choose a file to upload.")).toBeTruthy());
    expect(screen.queryByText("Something went wrong.")).toBeNull();
  });

  it("REQUIRED: a previous server error clears the moment a new file is picked", async () => {
    const uploadAction = vi.fn(async () => ({ error: "invalidImage" }) as ActionState);
    const input = renderUploader({ uploadAction });

    selectFile(input, png());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.getByText("Could not read that file as an image.")).toBeTruthy());

    selectFile(input, png());
    expect(screen.queryByText("Could not read that file as an image.")).toBeNull();
  });

  it("REQUIRED: previous success feedback clears when a different file is selected", async () => {
    const uploadAction = vi.fn(async () => ({ ok: true }) as ActionState);
    const input = renderUploader({ uploadAction });

    selectFile(input, png());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.getByText("Logo uploaded.")).toBeTruthy());

    selectFile(input, png());
    expect(screen.queryByText("Logo uploaded.")).toBeNull();
  });

  it("REQUIRED: an in-flight result cannot appear as feedback for a newly selected file", async () => {
    const first = deferred<ActionState>();
    const uploadAction = vi.fn(async () => first.promise);
    const input = renderUploader({ uploadAction });

    selectFile(input, png());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    // Before the first submission resolves, the director picks a different file.
    selectFile(input, png());

    first.resolve({ error: "invalidImage" });
    // Give the resolved promise's state update a tick to flush, then assert
    // the stale result never rendered under the new selection.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Could not read that file as an image.")).toBeNull();
  });

  it("REQUIRED: the object URL is revoked on replacement and on unmount", () => {
    const input = renderUploader();

    selectFile(input, png());
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).not.toHaveBeenCalled();

    selectFile(input, png());
    expect(createObjectURLMock).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-url");

    cleanup();
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["permissionDenied", "There's a problem with logo storage. Contact an administrator. (LOGO-PERM)"],
    ["bucketMissing", "There's a problem with logo storage. Contact an administrator. (LOGO-BUCKET)"],
    ["storageUnavailable", "Try again shortly. If this continues, contact an administrator. (LOGO-DOWN)"],
    ["storageRateLimited", "Storage is busy right now — try again in a moment."],
  ] as const)("REQUIRED: %s renders its own message and support code", async (error, expectedText) => {
    const uploadAction = vi.fn(async () => ({ error }) as ActionState);
    const input = renderUploader({ uploadAction });

    selectFile(input, png());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(screen.getByText(expectedText)).toBeTruthy());
  });
});
