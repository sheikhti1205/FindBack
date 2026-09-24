import { describe, expect, it, vi } from "vitest";
import { candidateHostFrom } from "./candidateHost";

describe("candidate host bridge", () => {
  it("keeps catalogue identity through state, transfer and real verification calls", async () => {
    const calls: string[] = [];
    const native = {
      getCandidateStates: async () => ({ models: [{ entryId: "lfm2.5-vl-450m", state: "INSTALLED_UNVERIFIED", installed: true, sizeBytes: 406817104, downloadedBytes: 0 }] }),
      downloadCandidateModel: async ({ entryId }: { entryId: string }) => { calls.push(`download:${entryId}`); },
      pauseCandidateDownload: async ({ entryId }: { entryId: string }) => { calls.push(`pause:${entryId}`); },
      cancelCandidateDownload: async ({ entryId }: { entryId: string }) => { calls.push(`cancel:${entryId}`); },
      verifyCandidateModel: async ({ entryId, imageUri }: { entryId: string; imageUri?: string }) => {
        calls.push(`verify:${entryId}:${imageUri}`);
        return { entryId, ready: true, observedOnThisDevice: true, loadMs: 3, inferenceMs: 5 };
      },
      deleteCandidateModel: async ({ entryId }: { entryId: string }) => { calls.push(`delete:${entryId}`); },
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    };
    const host = candidateHostFrom(native);
    expect((await host.getStates())[0]?.state).toBe("INSTALLED_UNVERIFIED");
    await host.download("lfm2.5-vl-450m");
    await host.pause("lfm2.5-vl-450m");
    await host.cancel("lfm2.5-vl-450m");
    expect(await host.verify("lfm2.5-vl-450m", "content://image")).toMatchObject({ ready: true, inferenceMs: 5 });
    await host.delete("lfm2.5-vl-450m");
    expect(calls).toEqual([
      "download:lfm2.5-vl-450m", "pause:lfm2.5-vl-450m", "cancel:lfm2.5-vl-450m",
      "verify:lfm2.5-vl-450m:content://image", "delete:lfm2.5-vl-450m",
    ]);
  });
});
