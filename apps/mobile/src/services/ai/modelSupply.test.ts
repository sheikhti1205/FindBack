import { expect, it } from "vitest";
import { productionModelRegistry } from "./modelDescriptors";
it("offers all families as pinned Advanced evaluation, never production roles", () => {
  const registry = productionModelRegistry();
  for (const id of ["lfm2-350m-q4_0", "lfm2-700m-q4_0", "lfm2-1.2b-q4_0", "granite-3.3-2b-instruct-q4_0", "qwen3-1.7b-dynamic-int4", "lfm2-vl-450m-q4_0", "lfm2-vl-1.6b-q4_0", "qwen3-vl-2b-instruct-q4_k_m", "lfm2.5-1.2b-q4_0", "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb"]) {
    const d = registry.requireDescriptor(id);
    expect(d.downloadable, id).toBe(true);
    expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(d.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(d.bytes).toBeGreaterThan(0);
    expect(d.taskRoles).toEqual([]);
    expect(d.maturity).toBe("lab");
  }
  expect(registry.requireDescriptor("lfm2-vl-450m-q4_0").companions).toHaveLength(1);
  expect(registry.requireDescriptor("lfm2.5-vl-450m-stock").revision).toBe("da7396bf02715c332c21d0117d48a05851db5fb0");
});
