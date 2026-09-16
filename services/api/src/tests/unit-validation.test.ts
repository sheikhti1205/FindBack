import { describe, expect, it } from "vitest";
import {
  extractYouTubeId,
  normalizePhone,
  toFieldErrors,
  registerSchema,
} from "@findback/shared";

describe("shared validation + helpers", () => {
  it("validates username rules", () => {
    const parsed = registerSchema.safeParse({
      username: "ok_user1",
      email: "a@b.com",
      phone: "01812345678",
      password: "password123",
    });
    expect(parsed.success).toBe(true);

    const bad = registerSchema.safeParse({
      username: "no spaces",
      email: "not-an-email",
      phone: "123",
      password: "short",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const fields = toFieldErrors(bad.error);
      expect(fields.username).toMatch(/letters/);
      expect(fields.email).toBeTruthy();
      expect(fields.phone).toBeTruthy();
      expect(fields.password).toBeTruthy();
    }
  });

  it("normalizes Bangladeshi phones", () => {
    expect(normalizePhone("01812345678")).toBe("+8801812345678");
    expect(normalizePhone("+8801812345678")).toBe("+8801812345678");
    expect(normalizePhone("01112345678")).toBeNull();
  });

  it("extracts YouTube ids from common URL shapes", () => {
    const id = "dQw4w9WgXcQ";
    expect(extractYouTubeId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
    expect(extractYouTubeId(`https://youtu.be/${id}`)).toBe(id);
    expect(extractYouTubeId(`https://www.youtube.com/embed/${id}`)).toBe(id);
    expect(extractYouTubeId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(extractYouTubeId("not a url")).toBeNull();
  });
});
