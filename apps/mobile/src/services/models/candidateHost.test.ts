import { describe, expect, it, vi } from "vitest";
import {
  candidateHostFrom,
  isCandidateResidentReady,
  type CandidateActiveStatus,
} from "./candidateHost";

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
      useCandidateModel: async ({ entryId }: { entryId: string }) => {
        calls.push(`use:${entryId}`);
        return { entryId, role: "IMAGE" as const, ready: true, loadMs: 7 };
      },
      releaseCandidateModel: async () => { calls.push("releaseUse"); },
      getCandidateActive: async () => ({ entryId: null as string | null }),
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    };
    const host = candidateHostFrom(native);
    expect((await host.getStates())[0]?.state).toBe("INSTALLED_UNVERIFIED");
    await host.download("lfm2.5-vl-450m");
    await host.pause("lfm2.5-vl-450m");
    await host.cancel("lfm2.5-vl-450m");
    expect(await host.verify("lfm2.5-vl-450m", "content://image")).toMatchObject({ ready: true, inferenceMs: 5 });
    expect(await host.use("lfm2.5-vl-450m")).toMatchObject({ role: "IMAGE", ready: true });
    expect(await host.getActive()).toBeNull();
    await host.releaseUse();
    await host.delete("lfm2.5-vl-450m");
    expect(calls).toEqual([
      "download:lfm2.5-vl-450m", "pause:lfm2.5-vl-450m", "cancel:lfm2.5-vl-450m",
      "verify:lfm2.5-vl-450m:content://image", "use:lfm2.5-vl-450m", "releaseUse",
      "delete:lfm2.5-vl-450m",
    ]);
  });
});

describe("candidate active truth (AI-04/AI-07)", () => {
  const VISION = "lfm2.5-vl-450m";

  function nativeWithActive(status: unknown) {
    return {
      getCandidateStates: async () => ({ models: [] }),
      downloadCandidateModel: async () => undefined,
      pauseCandidateDownload: async () => undefined,
      cancelCandidateDownload: async () => undefined,
      verifyCandidateModel: async ({ entryId }: { entryId: string }) => ({
        entryId, ready: false, observedOnThisDevice: false, loadMs: 0, inferenceMs: 0,
      }),
      deleteCandidateModel: async () => undefined,
      useCandidateModel: async ({ entryId }: { entryId: string }) => ({
        entryId, role: "IMAGE" as const, ready: false, loadMs: 0,
      }),
      releaseCandidateModel: async () => undefined,
      getCandidateActive: async () => status,
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    };
  }

  it("exposes the full native selection/residency truth, failing closed on legacy shapes", async () => {
    const full = candidateHostFrom(nativeWithActive({
      entryId: VISION,
      selectedEntryId: VISION,
      installedVerified: true,
      residentEntryId: VISION,
      initialized: true,
    }) as never);
    expect(await full.getActiveStatus?.()).toEqual({
      entryId: VISION,
      selectedEntryId: VISION,
      installedVerified: true,
      residentEntryId: VISION,
      initialized: true,
    });

    const legacy = candidateHostFrom(nativeWithActive({ entryId: VISION }) as never);
    expect(await legacy.getActiveStatus?.()).toEqual({
      entryId: VISION,
      selectedEntryId: VISION,
      installedVerified: false,
      residentEntryId: null,
      initialized: false,
    });

    const empty = candidateHostFrom(nativeWithActive({ entryId: null }) as never);
    expect(await empty.getActiveStatus?.()).toEqual({
      entryId: null,
      selectedEntryId: null,
      installedVerified: false,
      residentEntryId: null,
      initialized: false,
    });
  });

  it("reports genuinely resident only for verified+initialized residence, never the pointer alone", () => {
    const resident: CandidateActiveStatus = {
      entryId: VISION,
      selectedEntryId: VISION,
      installedVerified: true,
      residentEntryId: VISION,
      initialized: true,
    };
    expect(isCandidateResidentReady(resident, VISION)).toBe(true);
    // Selected but never activated (cold restart), deleted bytes, or released.
    expect(
      isCandidateResidentReady(
        { ...resident, residentEntryId: null, initialized: false },
        VISION,
      ),
    ).toBe(false);
    expect(
      isCandidateResidentReady(
        { ...resident, installedVerified: false, residentEntryId: null, initialized: false },
        VISION,
      ),
    ).toBe(false);
    expect(
      isCandidateResidentReady({ ...resident, entryId: "other", selectedEntryId: "other" }, VISION),
    ).toBe(false);
    expect(isCandidateResidentReady(null, VISION)).toBe(false);
    expect(isCandidateResidentReady(undefined, VISION)).toBe(false);
  });
});
