import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pure-node PNG IHDR reader (no new deps): width/height live at bytes 16-23.
function pngSize(url: URL): { width: number; height: number } {
  const buf = readFileSync(url);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error(`${url} is not a PNG`);
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error(`${url} missing IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function brandPng(name: string) {
  return new URL(`./${name}`, import.meta.url);
}

function resPng(rel: string) {
  return new URL(`../../../android/app/src/main/res/${rel}`, import.meta.url);
}

function webPng(name: string) {
  return new URL(`../../../public/icons/${name}`, import.meta.url);
}

describe("brand assets (LOGO2 derived rasters)", () => {
  it.each([
    ["brand-mark-dark.png", 512],
    ["brand-mark-light.png", 512],
    ["brand-tile-dark.png", 512],
    ["brand-tile-light.png", 512],
  ])("%s is %ix%i", (name, size) => {
    expect(pngSize(brandPng(name))).toEqual({ width: size, height: size });
  });

  // The tile is a DERIVED asset: geometry and glyph come from the owner's
  // master via `sessions/home-chrome/harness/derive-brand-tile.py`, and the
  // polarity is what makes it legible in each theme. Size alone would not
  // notice a wrong derivation or a re-export with the wrong polarity, so the
  // derived bytes are pinned. Re-derive and update these deliberately.
  it.each([
    ["brand-tile-dark.png", "b9ec78609b98a3697732d2dff43dea1fb899c51b8693df5659f489f4e60073b4"],
    ["brand-tile-light.png", "17a5370d16875e589c52317f95457ae1b39ee81c55717adcc481ebc62624af79"],
  ])("%s matches the pinned derived bytes", (name, hash) => {
    const digest = createHash("sha256").update(readFileSync(brandPng(name))).digest("hex");
    expect(digest).toBe(hash);
  });

  it.each([
    ["findback-192.png", 192],
    ["findback-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("web icon %s is %ix%i", (name, size) => {
    expect(pngSize(webPng(name))).toEqual({ width: size, height: size });
  });

  it.each([
    ["mipmap-mdpi/ic_launcher.png", 48],
    ["mipmap-hdpi/ic_launcher.png", 72],
    ["mipmap-xhdpi/ic_launcher.png", 96],
    ["mipmap-xxhdpi/ic_launcher.png", 144],
    ["mipmap-xxxhdpi/ic_launcher.png", 192],
  ])("launcher %s is %ipx square", (rel, size) => {
    expect(pngSize(resPng(rel))).toEqual({ width: size, height: size });
  });

  it.each([
    ["mipmap-mdpi/ic_launcher_foreground.png", 108],
    ["mipmap-hdpi/ic_launcher_foreground.png", 162],
    ["mipmap-xhdpi/ic_launcher_foreground.png", 216],
    ["mipmap-xxhdpi/ic_launcher_foreground.png", 324],
    ["mipmap-xxxhdpi/ic_launcher_foreground.png", 432],
    ["drawable-mdpi/ic_launcher_monochrome.png", 108],
    ["drawable-hdpi/ic_launcher_monochrome.png", 162],
    ["drawable-xhdpi/ic_launcher_monochrome.png", 216],
    ["drawable-xxhdpi/ic_launcher_monochrome.png", 324],
    ["drawable-xxxhdpi/ic_launcher_monochrome.png", 432],
  ])("adaptive/monochrome %s is %ipx square", (rel, size) => {
    expect(pngSize(resPng(rel))).toEqual({ width: size, height: size });
  });
});
