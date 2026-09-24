import { describe, expect, it } from "vitest";
import { transferHostFrom } from "./packageTransferHost";

const manifest = {
  packageVersion: "1" as const,
  entryId: "custom-model",
  upstream: { repo: "fixture", rev: "v", file: "model.litertlm" },
  createdAt: "2026-09-23T00:00:00Z",
  files: [{ path: "weights/model.litertlm", bytes: 31, sha256: "ab", method: "STORE" as const }],
};

describe("package transfer host bridge", () => {
  it("passes pick, inspect, commit and discard through with caller-side ids only", async () => {
    const calls: string[] = [];
    const native = {
      pickImportPackage: async () => ({ uri: "content://doc", name: "custom.fbmodel" }),
      inspectImportPackage: async ({ sourceUri }: { sourceUri: string }) => {
        calls.push(`inspect:${sourceUri}`);
        return { inspectionId: "session-1", entryId: "custom-model", packageSha256: "cd", unknown: true, manifest };
      },
      commitInspectedPackage: async ({ inspectionId }: { inspectionId: string }) => {
        calls.push(`commit:${inspectionId}`);
        return { ok: true, entryId: "custom-model" };
      },
      discardInspectedPackage: async ({ inspectionId }: { inspectionId: string }) => {
        calls.push(`discard:${inspectionId}`);
      },
      importPackageFromUri: async () => ({ ok: true }),
      exportSelectedModels: async () => ({ results: [] }),
    };
    const host = transferHostFrom(native);
    expect(await host.pickImport()).toMatchObject({ uri: "content://doc" });
    const inspected = await host.inspect("content://doc");
    expect(inspected).toMatchObject({ inspectionId: "session-1", unknown: true });
    expect(await host.commit("session-1")).toMatchObject({ entryId: "custom-model" });
    await host.discard("session-1");
    expect(calls).toEqual(["inspect:content://doc", "commit:session-1", "discard:session-1"]);
  });

  it("maps known import pins and global export ids without re-pinning", async () => {
    const calls: string[] = [];
    const native = {
      pickImportPackage: async () => ({}),
      inspectImportPackage: async () => { throw new Error("unused"); },
      commitInspectedPackage: async () => { throw new Error("unused"); },
      discardInspectedPackage: async () => {},
      importPackageFromUri: async (args: { entryId: string; sourceUri: string; expectedSha256: string }) => {
        calls.push(`known:${args.entryId}:${args.expectedSha256}`);
        return { ok: true };
      },
      exportSelectedModels: async ({ entryIds }: { entryIds: string[] }) => {
        calls.push(`export:${entryIds.join(",")}`);
        return { results: entryIds.map((entryId) => ({ entryId, fileName: `${entryId}.fbmodel`, ok: true })) };
      },
    };
    const host = transferHostFrom(native);
    await host.importKnown("smolvlm2-500m-litert-int4", "content://pkg", "41e1");
    const results = await host.exportAll(["a", "b"]);
    expect(results).toHaveLength(2);
    expect(calls).toEqual(["known:smolvlm2-500m-litert-int4:41e1", "export:a,b"]);
  });
});
