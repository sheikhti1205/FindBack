import { describe, expect, it } from "vitest";
import { z } from "zod";

// The live Zod guard survives removal of GraphQL-only dependency tests.
describe("dependency security — bounded collection validation", () => {
  it("rejects an oversized constrained collection before expanding per-element errors", () => {
    const result = z.array(z.string()).max(2).safeParse(Array.from({ length: 1000 }, () => null));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe("too_big");
    }
  });
});
