import { describe, expect, it } from "vitest";
import { BootTimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  it("resolves with the task value when fast enough", async () => {
    await expect(withTimeout(() => Promise.resolve(42), 1000, "slow")).resolves.toBe(42);
  });

  it("rejects with BootTimeoutError when the task hangs", async () => {
    const hanging = new Promise<never>(() => undefined);
    await expect(withTimeout(() => hanging, 10, "Session restore timed out")).rejects.toThrow(
      BootTimeoutError,
    );
  });

  it("propagates the task rejection instead of masking it", async () => {
    await expect(withTimeout(() => Promise.reject(new Error("boom")), 1000, "slow")).rejects.toThrow(
      "boom",
    );
  });
});
