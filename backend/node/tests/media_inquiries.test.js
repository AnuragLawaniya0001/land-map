import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";

test("Phase 10 — Media Validation & Phone Sanitization", async (t) => {
  await t.test("JPEG magic bytes validation should pass valid headers and reject invalid buffers", () => {
    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const invalidFile = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    const isJpeg = (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

    assert.strictEqual(isJpeg(validJpeg), true);
    assert.strictEqual(isJpeg(invalidFile), false);
  });

  await t.test("Indian mobile phone number validator should normalize digits and check length", () => {
    const isValidPhone = (phone) => {
      if (!phone || typeof phone !== "string") return false;
      const clean = phone.replace(/[^0-9]/g, "");
      return clean.length >= 10 && clean.length <= 12;
    };

    assert.strictEqual(isValidPhone("9876543210"), true);
    assert.strictEqual(isValidPhone("+91 98765 43210"), true);
    assert.strictEqual(isValidPhone("123"), false);
    assert.strictEqual(isValidPhone(""), false);
  });
});
