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
  ])("%s is %ix%i", (name, size) => {
    expect(pngSize(brandPng(name))).toEqual({ width: size, height: size });
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
