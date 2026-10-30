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

  it.each([
    "https://youtube.com/watch?feature=shared&v=dQw4w9WgXcQ#t=12",
    "https://youtu.be/dQw4w9WgXcQ?si=tracking",
    " HTTPS://WWW.YOUTUBE.COM/shorts/dQw4w9WgXcQ ",
  ])("parses supported HTTPS YouTube URLs: %s", (url) => {
    expect(extractYouTubeId(url)).toBe("dQw4w9WgXcQ");
  });

  it.each([
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
    "data:text/html,youtube.com/watch?v=dQw4w9WgXcQ",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "//youtube.com/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
    "https://user:password@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com:444/watch?v=dQw4w9WgXcQ",
    "https://www.youtu.be/dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQextra",
    "https://youtube.com/watch?v=dQw4w9WgXc!",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://youtube.com/embed/dQw4w9WgXcQextra",
    "https://youtube.com/shorts/dQw4w9WgXcQ/extra",
  ])("rejects untrusted origins, schemes and malformed video IDs: %s", (url) => {
    expect(extractYouTubeId(url)).toBeNull();
  });
});
