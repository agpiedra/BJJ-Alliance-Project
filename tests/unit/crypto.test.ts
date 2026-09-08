import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { digestLookupSecret, generateRandomToken, hashSecret } from "@/lib/crypto";

describe("crypto helpers", () => {
  it("hashes a secret so the hash differs from the plaintext but verifies against it", async () => {
    const hash = await hashSecret("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(await bcrypt.compare("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect secret against the stored hash", async () => {
    const hash = await hashSecret("correct horse battery staple");
    expect(await bcrypt.compare("wrong guess", hash)).toBe(false);
  });

  it("generates a url-safe random token of non-zero length", () => {
    const token = generateRandomToken(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(0);
  });

  it("generates a different token on each call", () => {
    expect(generateRandomToken()).not.toBe(generateRandomToken());
  });
});

describe("digestLookupSecret", () => {
  it("is deterministic: the same secret and pepper always produce the same digest", () => {
    expect(digestLookupSecret("1234", "pepper-a")).toBe(digestLookupSecret("1234", "pepper-a"));
  });

  it("produces different digests for different peppers, given the same secret", () => {
    expect(digestLookupSecret("1234", "pepper-a")).not.toBe(digestLookupSecret("1234", "pepper-b"));
  });

  it("produces different digests for different secrets, given the same pepper", () => {
    expect(digestLookupSecret("1234", "pepper-a")).not.toBe(digestLookupSecret("5678", "pepper-a"));
  });
});
