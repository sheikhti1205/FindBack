// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { supaMock } = vi.hoisted(() => ({
  supaMock: {
    upload: vi.fn(),
    getPublicUrl: vi.fn(),
    remove: vi.fn(),
    getUser: vi.fn(),
  },
}));

vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getUser: supaMock.getUser },
    storage: {
      from: () => ({
        upload: supaMock.upload,
        getPublicUrl: supaMock.getPublicUrl,
        remove: supaMock.remove,
      }),
    },
  }),
}));

vi.mock("./image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image")>();
  return {
    ...actual,
    normalizeImage: vi.fn(async (file: File) => ({
      blob: file,
      mimeType: file.type || "image/jpeg",
      width: 10,
      height: 10,
    })),
  };
});

import {
  COMMENT_ATTACH_MAX,
  COMMENT_ATTACH_MAX_BYTES,
  createCommentAttachment,
  createKlipyAttachment,
  removeCommentAttachment,
  uploadCommentAttachment,
  validateAttachableFile,
} from "./commentAttachments";
import {
  appendBodyMedia,
  bodyHasInlineData,
  parseCommentBody,
} from "./commentBodyMedia";

function file(name: string, type: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("validateAttachableFile", () => {
  it("accepts photos and short videos within the cap", () => {
    expect(validateAttachableFile(file("a.jpg", "image/jpeg"))).toBeNull();
    expect(validateAttachableFile(file("b.mp4", "video/mp4", 5_000_000))).toBeNull();
  });

  it("accepts AVIF and BMP like the report pipeline (parity, no comment-scope exclusion)", () => {
    expect(validateAttachableFile(file("a.avif", "image/avif"))).toBeNull();
    expect(validateAttachableFile(file("b.bmp", "image/bmp"))).toBeNull();
    expect(createCommentAttachment(file("a.avif", "image/avif")).kind).toBe("photo");
    expect(createCommentAttachment(file("b.bmp", "image/bmp")).kind).toBe("photo");
  });

  it("rejects non-media, empty, and oversized files with consumer copy", () => {
    expect(validateAttachableFile(file("a.pdf", "application/pdf"))).toMatch(/photo|video/i);
    expect(validateAttachableFile(file("a.jpg", "image/jpeg", 0))).toMatch(/empty/i);
    expect(validateAttachableFile(file("a.mp4", "video/mp4", COMMENT_ATTACH_MAX_BYTES + 1))).toMatch(
      /too large/i,
    );
  });

  it("caps the strip (attachment model limit)", () => {
    expect(COMMENT_ATTACH_MAX).toBeGreaterThanOrEqual(1);
  });
});

describe("createCommentAttachment", () => {
  it("builds a ready entry with a blob preview (never base64)", () => {
    const entry = createCommentAttachment(file("pic.jpg", "image/jpeg"));
    expect(entry.kind).toBe("photo");
    expect(entry.status).toBe("ready");
    expect(entry.progress).toBe(0);
    expect(entry.previewUrl.startsWith("blob:")).toBe(true);
    expect(entry.remoteUrl).toBeUndefined();
  });

  it("classifies video picks", () => {
    expect(createCommentAttachment(file("v.mp4", "video/mp4")).kind).toBe("video");
  });
});

describe("createKlipyAttachment", () => {
  it("preserves provider URLs/slug and marks the entry uploaded", () => {
    const entry = createKlipyAttachment({
      slug: "happy-1",
      kind: "gifs",
      mediaUrl: "https://media.klipy.com/happy.gif",
      previewUrl: "https://media.klipy.com/happy-preview.gif",
      title: "Happy",
    });
    expect(entry.kind).toBe("gif");
    expect(entry.status).toBe("uploaded");
    expect(entry.remoteUrl).toBe("https://media.klipy.com/happy.gif");
    expect(entry.klipySlug).toBe("happy-1");
    expect(entry.klipyKind).toBe("gifs");
  });
});

describe("uploadCommentAttachment", () => {
  it("uploads through the owner-scoped Storage path and resolves a public URL", async () => {
    supaMock.getUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    supaMock.upload.mockResolvedValue({ error: null });
    supaMock.getPublicUrl.mockReturnValue({ data: { publicUrl: "https://cdn/x.mp4" } });
    const f = file("v.mp4", "video/mp4", 2048);
    const entry = createCommentAttachment(f);
    const seen: { loaded: number; total: number }[] = [];
    const res = await uploadCommentAttachment(entry, f, {
      onProgress: (p) => seen.push(p),
    });
    expect(res.remoteUrl).toBe("https://cdn/x.mp4");
    expect(res.objectKey.startsWith("u-1/")).toBe(true);
    expect(seen[0]).toEqual({ loaded: 0, total: 2048 });
    expect(seen[seen.length - 1]).toEqual({ loaded: 2048, total: 2048 });
    expect(supaMock.upload).toHaveBeenCalledTimes(1);
  });

  it("surfaces Storage failures (retryable) and requires auth", async () => {
    supaMock.getUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    supaMock.upload.mockResolvedValue({ error: new Error("offline") });
    const f = file("v.mp4", "video/mp4", 64);
    await expect(uploadCommentAttachment(createCommentAttachment(f), f)).rejects.toThrow();
    supaMock.getUser.mockResolvedValue({ data: { user: null }, error: new Error("no") });
    await expect(uploadCommentAttachment(createCommentAttachment(f), f)).rejects.toThrow(
      /authenticated/i,
    );
  });

  it("removeCommentAttachment revokes the preview and never throws", async () => {
    supaMock.remove.mockResolvedValue({ error: null });
    const entry = createCommentAttachment(file("pic.jpg", "image/jpeg"));
    await expect(removeCommentAttachment(entry)).resolves.toBeUndefined();
    await expect(
      removeCommentAttachment({ ...entry, objectKey: "u-1/x.jpg", remoteUrl: "https://cdn/x.jpg" }),
    ).resolves.toBeUndefined();
    expect(supaMock.remove).toHaveBeenCalledTimes(1);
  });
});

describe("commentBodyMedia", () => {
  it("appends media as https lines (never base64 in text)", () => {
    const body = appendBodyMedia("Nice find!", [
      { kind: "photo", remoteUrl: "https://cdn/a.jpg" },
      { kind: "gif", remoteUrl: "https://media.klipy.com/h.gif" },
      { kind: "video", remoteUrl: "https://cdn/b.mp4" },
    ]);
    expect(body).toContain("Nice find!");
    expect(body).toContain("![photo](https://cdn/a.jpg)");
    expect(body).toContain("![gif](https://media.klipy.com/h.gif)");
    expect(body).toContain("[video](https://cdn/b.mp4)");
    expect(bodyHasInlineData(body)).toBe(false);
  });

  it("parses media back out, leaving markdown text intact", () => {
    const body = "Hello **there**\n\n![photo](https://cdn/a.jpg)\n\n[video](https://cdn/b.mp4)";
    const parsed = parseCommentBody(body);
    expect(parsed.text).toBe("Hello **there**");
    expect(parsed.media).toEqual([
      { kind: "photo", url: "https://cdn/a.jpg", alt: "Attached photo" },
      { kind: "video", url: "https://cdn/b.mp4", alt: "Attached video" },
    ]);
  });

  it("leaves ordinary text (including user links) untouched", () => {
    const parsed = parseCommentBody("See https://example.com for details");
    expect(parsed.text).toBe("See https://example.com for details");
    expect(parsed.media).toEqual([]);
  });

  it("detects inline base64 payloads", () => {
    expect(bodyHasInlineData("![x](data:image/png;base64,AAA)")).toBe(true);
    expect(bodyHasInlineData("plain text")).toBe(false);
  });
});
