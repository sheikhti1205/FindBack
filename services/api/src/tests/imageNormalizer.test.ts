import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeImage } from "../storage/imageNormalizer.js";

// 1x1 transparent GIF (smallest valid image, safe animation-passthrough fixture).
const TINY_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function makeImage(
  format: "jpeg" | "png" | "webp",
  width: number,
  height: number,
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  });
  if (format === "png") return pipeline.png().toBuffer();
  if (format === "webp") return pipeline.webp().toBuffer();
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

describe("normalizeImage", () => {
  it("reduces a large JPEG to the max edge without enlarging", async () => {
    const input = await makeImage("jpeg", 2400, 1200);
    const out = await normalizeImage(input, "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    expect(out.mimeType).toBe("image/jpeg");
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(960);
    expect(out.buffer.byteLength).toBeLessThan(input.byteLength);
  });

  it("does not enlarge a small image", async () => {
    const input = await makeImage("jpeg", 320, 240);
    const out = await normalizeImage(input, "image/jpeg");
    const meta = await sharp(out.buffer).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });

  it("keeps PNG output as PNG and WEBP as WEBP", async () => {
    const png = await normalizeImage(await makeImage("png", 800, 600), "image/png");
    expect(png.mimeType).toBe("image/png");
    expect((await sharp(png.buffer).metadata()).format).toBe("png");

    const webp = await normalizeImage(await makeImage("webp", 800, 600), "image/webp");
    expect(webp.mimeType).toBe("image/webp");
    expect((await sharp(webp.buffer).metadata()).format).toBe("webp");
  });

  it("passes GIF bytes through unchanged (safe animation behavior)", async () => {
    const out = await normalizeImage(TINY_GIF, "image/gif");
    expect(out.mimeType).toBe("image/gif");
    expect(out.buffer.equals(TINY_GIF)).toBe(true);
  });

  it("rejects undecodable input", async () => {
    await expect(normalizeImage(Buffer.from("not an image"), "image/jpeg")).rejects.toThrow();
  });
});
