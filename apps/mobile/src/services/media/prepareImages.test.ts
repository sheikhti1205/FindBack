import { describe, expect, it } from "vitest";
import { hasNoInlineImageBytesOrKeys, type NormalizedRequest } from "../ai/providerContract";
import { importImage, type ImportedImage, type TranscodeRequest } from "./importImage";
import {
  MAX_CHAT_SELECTIONS,
  MAX_REPORT_PHOTOS,
  PrepareError,
  addChatSelection,
  buildChatSendPlan,
  buildReportManifest,
  createChatTray,
  frameDisclosureFor,
  removeChatSelection,
  reorderChatSelection,
  reorderReportPhotos,
  toApprovedImageIds,
} from "./prepareImages";
import { buildGif, buildJpeg, buildPng, buildWebp } from "./__fixtures__/synthetic";

async function fakeEncode(request: TranscodeRequest): Promise<Uint8Array> {
  const out = new Uint8Array(Math.min(request.bytes.length, 512));
  out.fill(0xb6);
  return out;
}

async function makeStill(index: number): Promise<ImportedImage> {
  return importImage(
    {
      bytes: buildPng(24 + index, 24),
      fileName: `still-${index}.png`,
      declaredMimeType: "image/png",
    },
    { transcode: fakeEncode, webpEncodeSupported: true },
  );
}

async function makeAnimatedGif(): Promise<ImportedImage> {
  return importImage(
    { bytes: buildGif(48, 48, { animated: true }), fileName: "anim.gif", declaredMimeType: "image/gif" },
    { transcode: fakeEncode, webpEncodeSupported: true },
  );
}

async function makeAnimatedWebp(): Promise<ImportedImage> {
  return importImage(
    {
      bytes: buildWebp(48, 48, { animated: true }),
      fileName: "anim.webp",
      declaredMimeType: "image/webp",
    },
    { transcode: fakeEncode, webpEncodeSupported: true },
  );
}

async function makeTray(count: number) {
  let tray = createChatTray();
  for (let index = 0; index < count; index += 1) {
    tray = addChatSelection(tray, await makeStill(index));
  }
  return tray;
}

describe("chat tray retention", () => {
  it(`holds ${MAX_CHAT_SELECTIONS} selections until explicit send`, async () => {
    const tray = await makeTray(10);
    expect(tray.items).toHaveLength(10);
    expect(tray.items.map((item) => item.preview.byteLength).every((size) => size > 0)).toBe(true);
  });

  it("keeps all 10 selections under a 4-image model limit with an honest notice", async () => {
    const tray = await makeTray(10);
    const plan = buildChatSendPlan(tray, { modelMaxImages: 4 });
    expect(plan.retainedIds).toHaveLength(10);
    expect(plan.sendIds).toHaveLength(10);
    expect(plan.retainedCount).toBe(10);
    expect(plan.modelMaxImages).toBe(4);
    expect(plan.capacityNotice).toMatch(/4/);
    expect(plan.capacityNotice).toMatch(/kept|retained/i);
    expect(plan.capacityNotice).toMatch(/nothing was dropped/i);
    // Planning never mutates the tray: nothing silently truncated.
    expect(tray.items).toHaveLength(10);
  });

  it("sends everything quietly when the model limit is unknown or sufficient", async () => {
    const tray = await makeTray(3);
    expect(buildChatSendPlan(tray).capacityNotice).toBeNull();
    expect(buildChatSendPlan(tray).sendIds).toHaveLength(3);
    const full = await makeTray(10);
    expect(buildChatSendPlan(full, { modelMaxImages: 10 }).capacityNotice).toBeNull();
  });

  it("removes and reorders individual selections", async () => {
    let tray = await makeTray(3);
    const [first, second, third] = [tray.items[0]!, tray.items[1]!, tray.items[2]!];
    tray = removeChatSelection(tray, second.id);
    expect(tray.items.map((item) => item.id)).toEqual([first.id, third.id]);
    tray = reorderChatSelection(tray, 1, 0);
    expect(tray.items.map((item) => item.id)).toEqual([third.id, first.id]);
  });

  it("blocks an 11th selection gently without losing the kept 10", async () => {
    const tray = await makeTray(10);
    try {
      addChatSelection(tray, await makeStill(99));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).code).toBe("TRAY_FULL");
      expect((error as Error).message).toMatch(/10/);
    }
    expect(tray.items).toHaveLength(10);
  });

  it("rejects out-of-range reorder and unknown removal", async () => {
    const tray = await makeTray(2);
    expect(() => reorderChatSelection(tray, 0, 5)).toThrowError(PrepareError);
    expect(() => removeChatSelection(tray, "img_missing")).toThrowError(PrepareError);
    expect(tray.items).toHaveLength(2);
  });
});

describe("animation disclosure", () => {
  it("discloses sampled frames for animated GIF and WebP, never claiming full viewing", async () => {
    for (const image of [await makeAnimatedGif(), await makeAnimatedWebp()]) {
      const disclosure = frameDisclosureFor(image);
      expect(disclosure).not.toBeNull();
      expect(disclosure).toMatch(/sampled/i);
      expect(disclosure).toMatch(/not every frame/i);
      expect(disclosure).not.toMatch(/all frames/i);
    }
  });

  it("returns no disclosure for stills", async () => {
    expect(frameDisclosureFor(await makeStill(1))).toBeNull();
    const stillJpeg = await importImage(
      { bytes: buildJpeg(32, 32), fileName: "s.jpg", declaredMimeType: "image/jpeg" },
      { transcode: fakeEncode, webpEncodeSupported: true },
    );
    expect(frameDisclosureFor(stillJpeg)).toBeNull();
  });
});

describe("report manifest", () => {
  it("accepts 0 photos", () => {
    expect(buildReportManifest([]).entries).toEqual([]);
  });

  it("orders 1 photo at display order 0", async () => {
    const manifest = buildReportManifest([await makeStill(0)]);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ displayOrder: 0 });
  });

  it(`orders ${MAX_REPORT_PHOTOS} photos explicitly`, async () => {
    const images: ImportedImage[] = [];
    for (let index = 0; index < 5; index += 1) images.push(await makeStill(index));
    const manifest = buildReportManifest(images);
    expect(manifest.entries.map((entry) => entry.displayOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(manifest.entries.map((entry) => entry.imageId)).toEqual(images.map((image) => image.id));
    expect(manifest.entries.every((entry) => entry.frameDisclosure === null)).toBe(true);
  });

  it("carries the animation disclosure on animated report entries", async () => {
    const manifest = buildReportManifest([await makeAnimatedGif()]);
    expect(manifest.entries[0]?.animated).toBe(true);
    expect(manifest.entries[0]?.frameDisclosure).toMatch(/sampled/i);
  });

  it("blocks a 6th photo gently and keeps the original five", async () => {
    const images: ImportedImage[] = [];
    for (let index = 0; index < 6; index += 1) images.push(await makeStill(index));
    try {
      buildReportManifest(images);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).code).toBe("REPORT_LIMIT");
      expect((error as Error).message).toMatch(/up to 5/i);
    }
    expect(images).toHaveLength(6);
  });

  it("reorders report photos with explicit display orders", async () => {
    const manifest = buildReportManifest([await makeStill(0), await makeStill(1), await makeStill(2)]);
    const reordered = reorderReportPhotos(manifest, 2, 0);
    expect(reordered.entries.map((entry) => entry.displayOrder)).toEqual([0, 1, 2]);
    expect(reordered.entries[0]?.imageId).toBe(manifest.entries[2]?.imageId);
    expect(() => reorderReportPhotos(manifest, 0, 9)).toThrowError(PrepareError);
  });
});

describe("reference-only provider handoff", () => {
  it("returns id references with no image bytes for a NormalizedRequest", async () => {
    const tray = await makeTray(4);
    const ids = toApprovedImageIds(tray.items);
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(id).toMatch(/^img_[A-Za-z0-9_-]+$/);
      expect(id.toLowerCase()).not.toContain("data:");
      expect(id.toLowerCase()).not.toContain("base64,");
    }
    const request: NormalizedRequest = {
      selection: {
        accountId: "acct_media_test",
        provider: "openrouter",
        modelId: "unit-test-model",
        mode: "free-only",
      },
      task: "image-question",
      policyVersion: "media-test-1",
      knowledgeVersion: "media-test-1",
      recentTurns: [],
      currentText: "What is in these photos?",
      approvedImageIds: ids,
      authorizedResultIds: [],
      maxOutputTokens: 600,
      signal: new AbortController().signal,
    };
    expect(hasNoInlineImageBytesOrKeys(request)).toBe(true);
    expect(JSON.stringify(request)).not.toContain("base64,");
  });

  it("never embeds derivative bytes in report entries", async () => {
    const manifest = buildReportManifest([await makeStill(0), await makeAnimatedGif()]);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("base64,");
    for (const entry of manifest.entries) {
      expect(entry).not.toHaveProperty("bytes");
      expect(entry).not.toHaveProperty("derivative");
    }
  });
});
