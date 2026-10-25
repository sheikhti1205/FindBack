import { describe, expect, it } from "vitest";
import { createPostSchema, feedQuerySchema, loginSchema, registerSchema, updatePostSchema } from "@findback/shared";
import { toFieldErrors } from "@findback/shared";

describe("shared validation compatibility across the patched Zod upgrade", () => {
  it("preserves feed coercion/defaults and rejects out-of-range limits", () => {
    expect(feedQuerySchema.parse({})).toEqual({ limit: 10, sort: "newest" });
    expect(feedQuerySchema.parse({ limit: "20", sort: "oldest" })).toEqual({ limit: 20, sort: "oldest" });
    for (const limit of [0, 21, "bad"]) expect(feedQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("preserves partial report updates, nullable coordinates and stripped unknown fields", () => {
    expect(updatePostSchema.parse({})).toEqual({});
    expect(updatePostSchema.parse({ latitude: null, title: "umbrella", privateFlag: true })).toEqual({ latitude: null, title: "umbrella" });
    expect(createPostSchema.safeParse({}).success).toBe(false);
    expect(updatePostSchema.safeParse({ title: "x" }).success).toBe(false);
  });

  it("preserves explicit consumer validation messages and first-error field mapping", () => {
    const parsed = registerSchema.safeParse({ username: "!", email: "bad", phone: "bad", password: "x" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(toFieldErrors(parsed.error)).toMatchObject({
      username: "Username must be at least 3 characters", email: "A valid email is required",
      phone: "Use a Bangladeshi mobile number, e.g. 01812345678", password: "Password must be at least 8 characters",
    });
    const login = loginSchema.safeParse({ identifier: "", password: "" });
    expect(login.success).toBe(false);
    if (!login.success) expect(toFieldErrors(login.error)).toEqual({ identifier: "Username or email required", password: "Password required" });
  });
});
