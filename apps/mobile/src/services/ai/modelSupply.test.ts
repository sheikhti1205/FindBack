import { expect, it } from "vitest";
import { productionModelRegistry } from "./modelDescriptors";

/**
 * The local generative lane is retired. These descriptors survive only so an
 * upgrade can still find and remove bytes a previous build downloaded — which
 * means the pins have to stay exact, and nothing may be offered or claimed.
 */
it("keeps every retired family's pins, and offers none of them", () => {
  const registry = productionModelRegistry();
  for (const id of ["lfm2-350m-q4_0", "lfm2-700m-q4_0", "lfm2-1.2b-q4_0", "granite-3.3-2b-instruct-q4_0", "qwen3-1.7b-dynamic-int4", "lfm2-vl-450m-q4_0", "lfm2-vl-1.6b-q4_0", "qwen3-vl-2b-instruct-q4_k_m", "lfm2.5-1.2b-q4_0", "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb"]) {
    const d = registry.requireDescriptor(id);
    // Cleanup-only: no download, no import, no product role, no automatic use.
    expect(d.cleanupOnly, id).toBe(true);
    expect(d.downloadable, id).toBe(false);
    expect(d.importable, id).toBe(false);
    expect(d.taskRoles).toEqual([]);
    // Pins survive, so the bytes are still identifiable on disk.
    expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(d.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(d.bytes).toBeGreaterThan(0);
    expect(d.maturity).toBe("lab");
  }
  expect(registry.requireDescriptor("lfm2-vl-450m-q4_0").companions).toHaveLength(1);
  expect(registry.requireDescriptor("lfm2.5-vl-450m-stock").revision).toBe("da7396bf02715c332c21d0117d48a05851db5fb0");
});
