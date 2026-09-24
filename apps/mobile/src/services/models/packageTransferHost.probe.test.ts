import { describe, expect, it } from "vitest";
import { transferHostFrom } from "./packageTransferHost";

const baseNative = {
  importPackageFromUri: async () => ({ ok: true }),
  exportSelectedModels: async () => ({ results: [] }),
};

describe("package transfer host agreed native contract", () => {
  it("probes an inspected session with the confirmed role and reports typed outcomes", async () => {
    const native = {
      ...baseNative,
      pickImportPackage: async () => ({}),
      inspectImportPackage: async () => { throw new Error("unused"); },
      commitInspectedPackage: async () => ({ ok: true, entryId: "x" }),
      discardInspectedPackage: async () => undefined,
      probeInspectedPackage: async (options: { inspectionId: string; role: string; imageUri?: string }) => {
        expect(options).toMatchObject({ inspectionId: "s1", role: "Vision" });
        return { ready: true, lowMemory: false, loadMs: 11, inferenceMs: 22, memoryBeforeMb: 3000, observedPeakMb: 3100 };
      },
    };
    const host = transferHostFrom(native);
    const result = await host.probe({ inspectionId: "s1", role: "Vision", imageUri: "content://photo" });
    expect(result).toMatchObject({ ready: true, lowMemory: false, loadMs: 11 });
  });

  it("commits unknown imports with explicit name, role and keepUnverified without re-pinning", async () => {
    const seen: unknown[] = [];
    const native = {
      ...baseNative,
      pickImportPackage: async () => ({}),
      inspectImportPackage: async () => { throw new Error("unused"); },
      commitInspectedPackage: async (options: unknown) => {
        seen.push(options);
        return { ok: true, entryId: "imported-1" };
      },
      discardInspectedPackage: async () => undefined,
    };
    const host = transferHostFrom(native);
    const committed = await host.commitDetailed({
      inspectionId: "s1",
      name: "My Vision Model",
      description: "Field test",
      role: "Vision",
      keepUnverified: true,
    });
    expect(committed).toMatchObject({ entryId: "imported-1" });
    expect(seen[0]).toMatchObject({ inspectionId: "s1", name: "My Vision Model", role: "Vision", keepUnverified: true });
  });

  it("lists and deletes imported models from the persistent registry", async () => {
    const native = {
      ...baseNative,
      pickImportPackage: async () => ({}),
      inspectImportPackage: async () => { throw new Error("unused"); },
      commitInspectedPackage: async () => ({ ok: true, entryId: "x" }),
      discardInspectedPackage: async () => undefined,
      getImportedModels: async () => ({
        models: [{ entryId: "imported-1", label: "My Vision Model", role: "Vision" as const, state: "INSTALLED_UNVERIFIED", bytes: 416000000 }],
      }),
      deleteImportedModel: async (options: { entryId: string }) => {
        expect(options).toMatchObject({ entryId: "imported-1" });
      },
    };
    const host = transferHostFrom(native);
    const models = await host.getImported();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ label: "My Vision Model" });
    await host.deleteImported("imported-1");
  });

  it("stays honest when the native peer method has not landed yet", async () => {
    const native = {
      ...baseNative,
      pickImportPackage: async () => ({}),
      inspectImportPackage: async () => { throw new Error("unused"); },
      commitInspectedPackage: async () => ({ ok: true, entryId: "x" }),
      discardInspectedPackage: async () => undefined,
    };
    const host = transferHostFrom(native);
    await expect(host.probe({ inspectionId: "s1", role: "Text" })).rejects.toThrow(/joint verification/i);
    await expect(host.getImported()).resolves.toEqual([]);
  });
});
