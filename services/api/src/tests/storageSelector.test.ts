import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { LocalStorageProvider } from "../storage/localStorageProvider.js";
import {
  selectStorageProvider,
  getStorageProvider,
  type StorageProvider,
} from "../storage/index.js";

describe("storage provider selection", () => {
  it("pins the test environment to sqlite even if DB_PROVIDER=supabase", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(config.dbProvider).toBe("sqlite");
  });

  it("selects LocalStorageProvider for sqlite", () => {
    expect(selectStorageProvider("sqlite")).toBeInstanceOf(LocalStorageProvider);
  });

  it("selects the Supabase provider factory for supabase", () => {
    const fake = {} as StorageProvider;
    const factory = vi.fn(() => fake);
    expect(selectStorageProvider("supabase", factory)).toBe(fake);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("never silently falls back to local when supabase is selected", () => {
    const factory = vi.fn(() => {
      throw new Error("Supabase Storage requires SUPABASE_URL");
    });
    expect(() => selectStorageProvider("supabase", factory)).toThrow("SUPABASE_URL");
  });

  it("the active provider is local in tests", () => {
    expect(getStorageProvider()).toBeInstanceOf(LocalStorageProvider);
  });
});
