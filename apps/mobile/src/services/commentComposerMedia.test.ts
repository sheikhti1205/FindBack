// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { supaMock } = vi.hoisted(() => ({
  supaMock: {
    upload: vi.fn(),
    getPublicUrl: vi.fn(),
    remove: vi.fn(),
    getUser: vi.fn(),
    fromBucket: vi.fn(),
  },
}));

vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getUser: supaMock.getUser },
    storage: {
      from: (bucket: string) => {
        supaMock.fromBucket(bucket);
        return {
          upload: supaMock.upload,
          getPublicUrl: supaMock.getPublicUrl,
          remove: supaMock.remove,
        };
      },
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
  COMMENT_MEDIA_BUCKET,
  createCommentAttachment,
  createKlipyAttachment,
  removeCommentAttachment,
  uploadCommentAttachment,
  validateAttachableFile,
} from "./commentAttachments";
import {
  appendBodyMedia,
  bodyHasInlineData,
  commentMediaProvenance,
  parseCommentBody,
} from "./commentBodyMedia";

function file(name: string, type: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  supaMock.fromBucket.mockClear();
});

const TRUSTED_STORAGE = (bucket: string, path: string) =>
  `https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/${bucket}/${path}`;

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
  it("uploads through the owner-scoped path of the dedicated comment-media bucket", async () => {
    supaMock.getUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    supaMock.upload.mockResolvedValue({ error: null });
    supaMock.getPublicUrl.mockReturnValue({
      data: { publicUrl: TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/x.mp4") },
    });
    const f = file("v.mp4", "video/mp4", 2048);
    const entry = createCommentAttachment(f);
    const seen: { loaded: number; total: number }[] = [];
    const res = await uploadCommentAttachment(entry, f, {
      onProgress: (p) => seen.push(p),
    });
    expect(res.remoteUrl).toBe(TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/x.mp4"));
    expect(res.objectKey.startsWith("u-1/")).toBe(true);
    expect(supaMock.fromBucket).toHaveBeenCalledWith(COMMENT_MEDIA_BUCKET);
    // The report image bucket must never receive comment media (FBX-013).
    expect(supaMock.fromBucket).not.toHaveBeenCalledWith("findback-images");
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
      { kind: "photo", remoteUrl: TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/a.jpg") },
      { kind: "gif", remoteUrl: "https://media.klipy.com/h.gif" },
      { kind: "video", remoteUrl: TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/b.mp4") },
    ]);
    expect(body).toContain("Nice find!");
    expect(body).toContain(`![photo](${TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/a.jpg")})`);
    expect(body).toContain("![gif](https://media.klipy.com/h.gif)");
    expect(body).toContain(`[video](${TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/b.mp4")})`);
    expect(bodyHasInlineData(body)).toBe(false);
  });

  it("parses media back out, leaving markdown text intact", () => {
    const photoUrl = TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/a.jpg");
    const videoUrl = TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/b.mp4");
    const body = `Hello **there**\n\n![photo](${photoUrl})\n\n[video](${videoUrl})`;
    const parsed = parseCommentBody(body);
    expect(parsed.text).toBe("Hello **there**");
    expect(parsed.media).toEqual([
      { kind: "photo", url: photoUrl, alt: "Attached photo" },
      { kind: "video", url: videoUrl, alt: "Attached video" },
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

describe("commentMediaProvenance (FBX-014)", () => {
  it("accepts own-storage and klipy https URLs", () => {
    expect(commentMediaProvenance(TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/a.jpg"))).toBe(
      "storage",
    );
    expect(commentMediaProvenance(TRUSTED_STORAGE("findback-images", "u-1/legacy.png"))).toBe(
      "storage",
    );
    expect(commentMediaProvenance("https://media.klipy.com/gifs/happy.gif")).toBe("klipy");
    expect(commentMediaProvenance("https://klipy.com/gifs/happy.gif")).toBe("klipy");
  });

  it("rejects non-https, foreign hosts, foreign buckets and ownerless paths", () => {
    const own = TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/a.jpg");
    expect(commentMediaProvenance(own.replace("https://", "http://"))).toBeNull();
    expect(commentMediaProvenance("https://evil.example/x.jpg")).toBeNull();
    expect(commentMediaProvenance("data:image/png;base64,AAA")).toBeNull();
    expect(commentMediaProvenance("not a url")).toBeNull();
    // Foreign bucket: same trusted host, but not a media bucket we serve.
    expect(
      commentMediaProvenance(
        TRUSTED_STORAGE("some-other-bucket", "u-1/a.jpg"),
      ),
    ).toBeNull();
    // Missing owner segment (`<bucket>/<file>` has no owner directory).
    expect(
      commentMediaProvenance(
        `https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/${COMMENT_MEDIA_BUCKET}/a.jpg`,
      ),
    ).toBeNull();
  });

  it("rejects the substring-attack shape (marker inside a foreign URL)", () => {
    expect(
      commentMediaProvenance(
        "https://evil.example/x/storage/v1/object/public/findback-images/u-1/f.png",
      ),
    ).toBeNull();
    expect(
      commentMediaProvenance(
        "https://evil.example/?next=/storage/v1/object/public/findback-images/u-1/f.png",
      ),
    ).toBeNull();
    expect(
      commentMediaProvenance(
        "https://nfjhpigbsyyoaaktfaev.supabase.co.evil.example/storage/v1/object/public/findback-images/u-1/f.png",
      ),
    ).toBeNull();
  });
});

describe("provenance enforcement (FBX-014)", () => {
  it("keeps an untrusted image-markdown line as inert text, never gallery media", () => {
    const parsed = parseCommentBody("Look at this\n\n![x](https://evil.example/p.png)");
    expect(parsed.media).toEqual([]);
    expect(parsed.text).toContain("![x](https://evil.example/p.png)");
  });

  it("keeps an untrusted bare video URL as inert text", () => {
    const parsed = parseCommentBody("https://evil.example/x.mp4");
    expect(parsed.media).toEqual([]);
    expect(parsed.text).toBe("https://evil.example/x.mp4");
  });

  it("lifts only provenance-checked media lines (klipy and own storage)", () => {
    const klipy = "https://media.klipy.com/gifs/happy.gif";
    const storagePhoto = TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/pic.png");
    const storageVideo = TRUSTED_STORAGE(COMMENT_MEDIA_BUCKET, "u-1/clip.mp4");
    const parsed = parseCommentBody(`![a](${klipy})\n![b](${storagePhoto})\n[video](${storageVideo})`);
    expect(parsed.media.map((m) => m.url)).toEqual([klipy, storagePhoto, storageVideo]);
  });

  it("refuses to append untrusted URLs (write-side guard)", () => {
    const body = appendBodyMedia("hi", [
      { kind: "photo", remoteUrl: "https://evil.example/p.png" },
      {
        kind: "video",
        remoteUrl:
          "http://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-1/x.mp4",
      },
    ]);
    expect(body).toBe("hi");
    expect(bodyHasInlineData(body)).toBe(false);
  });
});
