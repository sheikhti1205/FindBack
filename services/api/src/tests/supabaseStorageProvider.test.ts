import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FINDBACK_IMAGES_BUCKET,
  SupabaseStorageProvider,
  type SupabaseStorageOperations,
} from "../storage/supabaseStorageProvider.js";
import { createSupabaseStorageOperations } from "../storage/supabaseStorageClient.js";

function fakeOps(overrides: Partial<SupabaseStorageOperations> = {}) {
  const ops: SupabaseStorageOperations = {
    upload: vi.fn(async () => ({ errorMessage: null })),
    remove: vi.fn(async () => ({ errorMessage: null })),
    getPublicUrl: vi.fn((p: string) => `https://proj.supabase.co/storage/v1/object/public/${FINDBACK_IMAGES_BUCKET}/${p}`),
    ...overrides,
  };
  return ops;
}

describe("createSupabaseStorageOperations", () => {
  function fakeSdk() {
    const calls: {
      bucket?: string;
      upload?: { path: string; body: Buffer; opts: unknown };
      remove?: string[];
    } = {};
    const from = (bucket: string) => {
      calls.bucket = bucket;
      return {
        upload: async (path: string, body: Buffer, opts: unknown) => {
          calls.upload = { path, body, opts };
          return { error: null };
        },
        remove: async (paths: string[]) => {
          calls.remove = paths;
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${path}` },
        }),
      };
    };
    return { client: { storage: { from } } as unknown as SupabaseClient, calls };
  }

  it("targets the findback-images bucket with contentType and upsert:false", async () => {
    const { client, calls } = fakeSdk();
    const ops = createSupabaseStorageOperations(client);
    const buffer = Buffer.from("bytes");
    await ops.upload("user/abc", buffer, { contentType: "image/jpeg", upsert: false });
    expect(calls.bucket).toBe(FINDBACK_IMAGES_BUCKET);
    expect(calls.upload?.path).toBe("user/abc");
    expect(calls.upload?.opts).toEqual({ contentType: "image/jpeg", upsert: false });
  });

  it("maps getPublicUrl to the public object URL", () => {
    const { client } = fakeSdk();
    const ops = createSupabaseStorageOperations(client);
    expect(ops.getPublicUrl("user/abc")).toBe(
      `https://proj.supabase.co/storage/v1/object/public/${FINDBACK_IMAGES_BUCKET}/user/abc`,
    );
  });

  it("maps SDK errors to errorMessage", async () => {
    const ops = createSupabaseStorageOperations({
      storage: {
        from: () => ({
          upload: async () => ({ error: { message: "bucket missing" } }),
          remove: async () => ({ error: { message: "remove failed" } }),
          getPublicUrl: () => ({ data: { publicUrl: "" } }),
        }),
      },
    } as unknown as SupabaseClient);
    expect(await ops.upload("a", Buffer.from("x"), { contentType: "image/png", upsert: false })).toEqual({
      errorMessage: "bucket missing",
    });
    expect(await ops.remove(["a"])).toEqual({ errorMessage: "remove failed" });
  });
});

describe("SupabaseStorageProvider", () => {
  it("stores under an opaque <userId>/<id> key with matching metadata", async () => {
    const ops = fakeOps();
    const provider = new SupabaseStorageProvider(ops);
    const buffer = Buffer.from("image-bytes");
    const stored = await provider.save(buffer, "image/jpeg", "My Photo.JPG", {
      userId: "user-123",
      id: "upload-abc",
    });

    expect(ops.upload).toHaveBeenCalledWith("user-123/upload-abc", buffer, {
      contentType: "image/jpeg",
      upsert: false,
    });
    expect(stored.objectKey).toBe("user-123/upload-abc");
    expect(stored.id).toBe("upload-abc");
    expect(stored.fileName).toBe("My Photo.JPG");
    expect(stored.mimeType).toBe("image/jpeg");
    expect(stored.fileSize).toBe(buffer.byteLength);
    expect(stored.fileUrl).toContain(`${FINDBACK_IMAGES_BUCKET}/user-123/upload-abc`);
  });

  it("never lets a client filename/path influence the object key", async () => {
    const ops = fakeOps();
    const stored = await new SupabaseStorageProvider(ops).save(
      Buffer.from("x"),
      "image/png",
      "../../etc/passwd",
      { userId: "u", id: "i" },
    );
    expect(stored.objectKey).toBe("u/i");
    expect(stored.fileName).toBe("passwd");
    expect(stored.fileName).not.toContain("/");
  });

  it("sanitizes a path-like userId into a safe namespace", async () => {
    const ops = fakeOps();
    const stored = await new SupabaseStorageProvider(ops).save(Buffer.from("x"), "image/png", "a.png", {
      userId: "../evil user",
      id: "i",
    });
    expect(stored.objectKey).toBe("eviluser/i");
  });

  it("throws when the Storage upload fails", async () => {
    const ops = fakeOps({ upload: vi.fn(async () => ({ errorMessage: "boom" })) });
    await expect(
      new SupabaseStorageProvider(ops).save(Buffer.from("x"), "image/png", "a.png", { userId: "u", id: "i" }),
    ).rejects.toThrow("Storing the image failed");
  });

  it("removes exactly the given object and surfaces removal failures", async () => {
    const okOps = fakeOps();
    await new SupabaseStorageProvider(okOps).remove("u/i");
    expect(okOps.remove).toHaveBeenCalledWith(["u/i"]);

    const badOps = fakeOps({ remove: vi.fn(async () => ({ errorMessage: "nope" })) });
    await expect(new SupabaseStorageProvider(badOps).remove("u/i")).rejects.toThrow(
      "Removing the stored image failed",
    );
  });
});
