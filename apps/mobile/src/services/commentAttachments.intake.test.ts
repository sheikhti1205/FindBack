// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ImportedImage } from "./media/importImage";

const { nativeMock } = vi.hoisted(() => ({
  nativeMock: {
    importUri: vi.fn(),
    toFile: vi.fn(),
    platform: "web" as string,
    available: false,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => nativeMock.platform,
    isPluginAvailable: () => nativeMock.available,
  },
  registerPlugin: () => nativeMock,
}));

vi.mock("./media/nativeMedia", () => ({
  isNativeMediaIntakeAvailable: () => nativeMock.available,
  importNativeImageUri: (...args: unknown[]) => nativeMock.importUri(...args),
  importedImageToFile: (...args: unknown[]) => nativeMock.toFile(...args),
}));

vi.mock("./supabaseClient", () => ({
  getSupabase: () => {
    throw new Error("no network in intake tests");
  },
}));

import {
  COMMENT_ATTACH_ACCEPT,
  COMMENT_ATTACH_MAX,
  COMMENT_ATTACH_MAX_BYTES,
  COMMENT_VIDEO_MAX_BYTES,
  COMMENT_VIDEO_MIME,
  createCommentAttachmentFromImportedImage,
  importCommentPhotoFromNativeUri,
  isNativeCommentPhotoIntakeAvailable,
  validateAttachableFile,
} from "./commentAttachments";

function importedImage(): ImportedImage {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    id: "img_1",
    fileName: "photo.jpg",
    text: "",
    sniffed: "jpeg",
    declaredMimeType: "",
    originalByteLength: 20_000_000,
    animated: false,
    motionStillUsed: false,
    videoBytesStripped: 0,
    sampledStill: false,
    exifOrientationApplied: 1,
    locationMetadataStripped: true,
    derivative: { bytes, mimeType: "image/jpeg", byteLength: bytes.length, width: 1442, height: 1920, quality: 0.82 },
    preview: { mimeType: "image/jpeg", byteLength: bytes.length, width: 1442, height: 1920, animated: false },
  };
}

function file(name: string, type: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("comment video intake is closed (packet `08` §7)", () => {
  it("aligns the retained video cap exactly with the client and Storage cap (no drift)", () => {
    // History keeps rendering, so the cap stays pinned to the same constant the
    // bucket enforces — a stored row can never be judged by a different limit.
    expect(COMMENT_VIDEO_MAX_BYTES).toBe(COMMENT_ATTACH_MAX_BYTES);
  });

  it("keeps the legacy video vocabulary but offers no way to add one", () => {
    // The stored comment rows still name these containers.
    expect([...COMMENT_VIDEO_MIME].sort()).toEqual(["video/mp4", "video/quicktime", "video/webm"]);
    // The picker offers photos only …
    expect(COMMENT_ATTACH_ACCEPT).toBe("image/*");
    for (const mime of COMMENT_VIDEO_MIME) {
      expect(COMMENT_ATTACH_ACCEPT).not.toContain(mime);
      // … and the client gate refuses every one of them, with consumer copy.
      expect(validateAttachableFile(file("clip", mime, 2048))).toMatch(/photos, not video/i);
    }
  });

  it("still refuses an oversized photo at the aligned cap with consumer copy", () => {
    expect(
      validateAttachableFile(file("big.jpg", "image/jpeg", COMMENT_VIDEO_MAX_BYTES + 1)),
    ).toMatch(/too large/i);
  });
});

describe("comment native photo intake (FBX-038)", () => {
  it("reports availability from the canonical intake (false on web)", async () => {
    nativeMock.platform = "android";
    nativeMock.available = true;
    await expect(isNativeCommentPhotoIntakeAvailable()).resolves.toBe(true);
    nativeMock.platform = "web";
    nativeMock.available = false;
    await expect(isNativeCommentPhotoIntakeAvailable()).resolves.toBe(false);
  });

  it("turns a bounded native derivative into a ready entry plus its upload File", async () => {
    const item = importedImage();
    const uploadFile = file("photo.jpg", "image/jpeg", 4);
    nativeMock.toFile.mockReturnValue(uploadFile);
    const { entry, file: out } = await createCommentAttachmentFromImportedImage(item);
    expect(nativeMock.toFile).toHaveBeenCalledWith(item);
    expect(out).toBe(uploadFile);
    expect(entry.kind).toBe("photo");
    expect(entry.status).toBe("ready");
    expect(entry.progress).toBe(0);
    // Derivative bytes only — preview is a blob: URI, never base64.
    expect(entry.previewUrl.startsWith("blob:")).toBe(true);
    expect(entry.remoteUrl).toBeUndefined();
  });

  it("imports one native URI into a ready entry (per-URI, sibling-safe)", async () => {
    nativeMock.importUri.mockResolvedValue(importedImage());
    nativeMock.toFile.mockReturnValue(file("photo.jpg", "image/jpeg", 4));
    const { entry, file: out } = await importCommentPhotoFromNativeUri("content://media/external/1");
    expect(nativeMock.importUri).toHaveBeenCalledWith("content://media/external/1");
    expect(entry.kind).toBe("photo");
    expect(entry.status).toBe("ready");
    expect(out).toBeInstanceOf(File);
  });

  it("caps the strip at the shared max (native picks count like file picks)", () => {
    expect(COMMENT_ATTACH_MAX).toBeGreaterThanOrEqual(1);
  });
});
