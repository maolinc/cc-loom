import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, needsPasswordRehash, verifyPassword } from "../lib/crypto.js";

describe("password hashing", () => {
  it("stores new passwords with scrypt and verifies only the matching value", () => {
    const stored = hashPassword("correct-horse-battery-staple");

    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword("correct-horse-battery-staple", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
    expect(needsPasswordRehash(stored)).toBe(false);
  });

  it("accepts the pre-release salt:sha256 format only for migration", () => {
    const salt = "legacy-salt";
    const digest = createHash("sha256").update(`${salt}legacy-password`).digest("hex");
    const stored = `${salt}:${digest}`;

    expect(verifyPassword("legacy-password", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
    expect(needsPasswordRehash(stored)).toBe(true);
  });

  it("rejects malformed stored values instead of throwing", () => {
    expect(verifyPassword("password", "scrypt$bad$data")).toBe(false);
    expect(verifyPassword("password", "not-a-password-hash")).toBe(false);
  });
});
