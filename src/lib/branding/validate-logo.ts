import sharp, { type Metadata } from "sharp";
import { ACCEPTED_MIME_TYPES, MAX_LOGO_BYTES, MAX_LOGO_DIMENSION, MAX_ASPECT_RATIO } from "./logo-constraints";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — logo upload validation.
 *
 * SVG is deliberately NOT in the accepted format list (a documented
 * deviation from the original Phase 4 draft, approved explicitly): inline
 * SVG can carry `<script>`/event-handler payloads, which needs a real
 * sanitizer to accept safely, and real gym logos are overwhelmingly
 * PNG/JPEG in practice — not worth that attack surface for this audience.
 *
 * The constants themselves live in ./logo-constraints (no `sharp` import),
 * so a client component can enforce the same limits before ever uploading a
 * byte — see logo-uploader.tsx. That client check is convenience only; this
 * file remains the actual authority, run again here regardless of what the
 * client already checked.
 */
export { ACCEPTED_MIME_TYPES, MAX_LOGO_BYTES, MAX_LOGO_DIMENSION, MAX_ASPECT_RATIO };

export type LogoValidationError = "invalidFormat" | "tooLarge" | "invalidImage" | "extremeAspectRatio";

export interface ValidatedLogo {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Validates AND re-encodes: decoding a claimed image and writing a fresh
 * file from its own decoded pixel data is what actually defeats a renamed
 * `.exe` (sharp fails outright on non-image bytes) as well as subtler
 * polyglot files (bytes appended after valid image data, which decode-then-
 * re-encode simply never reads). The declared `Content-Type` is checked,
 * but the DECODED format (`metadata.format`) is what's trusted — a renamed
 * file claiming `image/png` still fails here once sharp can't parse it as
 * one.
 *
 * Downscales (never upscales, never rejects) anything larger than
 * `MAX_LOGO_DIMENSION` on either side while its aspect ratio is reasonable —
 * a director submitting a nice high-res logo shouldn't get a cryptic
 * rejection for it. Only genuinely broken/oversized/wrong-shaped input is
 * refused.
 */
export async function validateAndReencodeLogo(
  bytes: Buffer,
  declaredMimeType: string,
): Promise<{ ok: true; result: ValidatedLogo } | { ok: false; error: LogoValidationError }> {
  if (bytes.byteLength > MAX_LOGO_BYTES) return { ok: false, error: "tooLarge" };
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(declaredMimeType)) {
    return { ok: false, error: "invalidFormat" };
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    return { ok: false, error: "invalidImage" };
  }

  const { width, height, format } = metadata;
  if (!width || !height) return { ok: false, error: "invalidImage" };
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    return { ok: false, error: "invalidFormat" };
  }

  const aspectRatio = Math.max(width / height, height / width);
  if (aspectRatio > MAX_ASPECT_RATIO) return { ok: false, error: "extremeAspectRatio" };

  const resized = sharp(bytes).resize({
    width: MAX_LOGO_DIMENSION,
    height: MAX_LOGO_DIMENSION,
    fit: "inside",
    withoutEnlargement: true,
  });
  const output = await resized.toFormat(format).toBuffer();
  const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";

  return { ok: true, result: { bytes: output, mimeType } };
}
