import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("forwards to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("boom", { code: 1 });
    expect(spy).toHaveBeenCalledWith("boom", { code: 1 });
  });
});
