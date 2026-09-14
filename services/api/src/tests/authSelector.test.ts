import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { LocalAuthProvider } from "../auth/localAuthProvider.js";
import { selectAuthProvider, getAuthProvider, type AuthProvider } from "../auth/index.js";

describe("auth provider selection", () => {
  it("pins the test environment to sqlite even if DB_PROVIDER=supabase", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(config.dbProvider).toBe("sqlite");
  });

  it("selects LocalAuthProvider for sqlite", () => {
    expect(selectAuthProvider("sqlite")).toBeInstanceOf(LocalAuthProvider);
  });

  it("selects the Supabase provider factory for supabase", () => {
    const fake = {} as AuthProvider;
    const factory = vi.fn(() => fake);
    expect(selectAuthProvider("supabase", factory)).toBe(fake);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("never silently falls back to local when supabase is selected", () => {
    const factory = vi.fn(() => {
      throw new Error("Supabase Auth requires SUPABASE_URL");
    });
    expect(() => selectAuthProvider("supabase", factory)).toThrow("SUPABASE_URL");
  });

  it("the active provider is local in tests", () => {
    expect(getAuthProvider()).toBeInstanceOf(LocalAuthProvider);
  });
});
