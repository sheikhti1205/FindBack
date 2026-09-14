import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import sharp from "sharp";
import { app, countRows, get, registerAgent } from "./helpers.js";
import { getStore } from "../db/index.js";
import { LocalStorageProvider } from "../storage/localStorageProvider.js";
import {
  setStorageProviderForTests,
  type StorageProvider,
  type StoredObject,
} from "../storage/index.js";

const BUCKET_URL = "https://proj.supabase.co/storage/v1/object/public/findback-images";

async function pngFixture(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } } })
    .png()
    .toBuffer();
}

function fakeProvider(overrides: Partial<StorageProvider> = {}) {
  const saved: string[] = [];
  const removed: string[] = [];
  const provider: StorageProvider = {
    async save(buffer, mimeType, originalName, context): Promise<StoredObject> {
      const id = context.id ?? randomUUID();
      const objectKey = `${context.userId}/${id}`;
      saved.push(objectKey);
      return {
        id,
        objectKey,
        fileName: originalName,
        mimeType,
        fileSize: buffer.byteLength,
        fileUrl: `${BUCKET_URL}/${objectKey}`,
      };
    },
    async remove(objectKey: string) {
      removed.push(objectKey);
    },
    ...overrides,
  };
  return { provider, saved, removed };
}

async function uploadFile(
  token: string,
  body: Buffer,
  filename: string,
  contentType: string,
): Promise<request.Response> {
  return request(app)
    .post("/uploads")
    .set("Authorization", `Bearer ${token}`)
    .attach("file", body, { filename, contentType });
}

async function uploadPng(token: string, fixture?: Buffer): Promise<request.Response> {
  return uploadFile(token, fixture ?? (await pngFixture()), "photo.png", "image/png");
}

describe("POST /uploads", () => {
  afterEach(() => {
    setStorageProviderForTests(null);
    vi.restoreAllMocks();
  });

  it("stores the image through the active provider and records the upload row", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(fakeProvider().provider);

    const res = await uploadPng(agent.token);
    expect(res.status).toBe(201);
    const upload = res.body.upload as StoredObject;
    expect(upload.id).toBeTruthy();
    expect(upload.fileUrl.startsWith(BUCKET_URL)).toBe(true);
    expect(upload.objectKey).toBeUndefined();

    const row = await get<Record<string, unknown>>("SELECT * FROM uploads WHERE id = ?", [upload.id]);
    expect(row?.user_id).toBe(agent.user.id);
    expect(row?.file_name).toBe("photo.png");
    expect(row?.mime_type).toBe("image/png");
    expect(row?.file_url).toBe(upload.fileUrl);
    expect(Number(row?.file_size)).toBe(upload.fileSize);
  });

  it("resolves an attachmentKey to the provider's returned fileUrl", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(fakeProvider().provider);

    const uploadRes = await uploadPng(agent.token);
    expect(uploadRes.status).toBe(201);
    const upload = uploadRes.body.upload as StoredObject;

    const created = await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({
        type: "FOUND",
        title: "Found a black umbrella near the library",
        description: "Black folding umbrella with a wooden handle found on a bench outside.",
        category: "Accessories & Jewelry",
        eventDate: "2026-09-10",
        locationLabel: "Central Library",
        latitude: 22.4688,
        longitude: 91.7835,
        attachmentKey: upload.id,
      });
    expect(created.status).toBe(201);

    const detail = await request(app).get(`/posts/${created.body.id as string}`);
    expect(detail.status).toBe(200);
    expect(detail.body.attachments?.[0]?.fileUrl).toBe(upload.fileUrl);
  });

  it("rolls back the stored object when the DB insert fails", async () => {
    const agent = await registerAgent();
    const { provider, removed } = fakeProvider();
    setStorageProviderForTests(provider);
    vi.spyOn(getStore(), "insertUpload").mockRejectedValueOnce(new Error("db down"));

    const res = await uploadPng(agent.token);
    expect(res.status).toBe(500);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.startsWith(`${agent.user.id}/`)).toBe(true);
    expect(await countRows("uploads", "user_id = ?", [agent.user.id])).toBe(0);
  });

  it("creates no upload row when the object write fails", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(
      fakeProvider({
        async save(): Promise<StoredObject> {
          throw new Error("storage down");
        },
      }).provider,
    );

    const res = await uploadPng(agent.token);
    expect(res.status).toBe(500);
    expect(await countRows("uploads", "user_id = ?", [agent.user.id])).toBe(0);
  });

  it("rejects a non-image MIME type with 400", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(fakeProvider().provider);
    const res = await uploadFile(agent.token, Buffer.from("hello"), "notes.txt", "text/plain");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PNG, JPG\/JPEG, WEBP and GIF/);
  });

  it("rejects an oversized image with 400", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(fakeProvider().provider);
    const res = await uploadFile(
      agent.token,
      Buffer.alloc(8 * 1024 * 1024 + 1, 1),
      "big.png",
      "image/png",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("rejects a corrupt image that passes the MIME filter", async () => {
    const agent = await registerAgent();
    setStorageProviderForTests(fakeProvider().provider);
    const res = await uploadFile(
      agent.token,
      Buffer.from("not really a png"),
      "fake.png",
      "image/png",
    );
    expect(res.status).toBe(400);
  });

  it("keeps working with the local filesystem provider", async () => {
    const agent = await registerAgent();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findback-uploads-"));
    setStorageProviderForTests(new LocalStorageProvider(dir));
    try {
      const res = await uploadPng(agent.token);
      expect(res.status).toBe(201);
      const upload = res.body.upload as StoredObject;
      const key = upload.fileUrl.split("/uploads/")[1] ?? "";
      expect(key).toBeTruthy();
      expect(fs.existsSync(path.join(dir, key))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
