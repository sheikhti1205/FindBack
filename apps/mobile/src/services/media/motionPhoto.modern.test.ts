import { describe, expect, it } from "vitest";
import { detectMotionPhoto, hasMotionPhotoMetadata } from "./motionPhoto";

function fixture(directory: string, padding = 8, extra = 0, flag = "1", aliases = false) {
  let xml = `<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:Camera="http://ns.google.com/photos/1.0/camera/" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" Camera:MotionPhoto="${flag}" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="24">${directory}</rdf:Description>`;
  if (aliases) xml = xml.replaceAll(/(xmlns:|\b)(GCamera|Camera|Container|Item)(?==|:)/g, (_, before: string, prefix: string) => before + ({ GCamera: "OldCam", Camera: "CamAlias", Container: "DirAlias", Item: "FieldAlias" }[prefix] ?? prefix));
  const header = new TextEncoder().encode(xml);
  const stillEnd = 2 + header.length + 2;
  const bytes = new Uint8Array(stillEnd + padding + 24 + extra);
  bytes.set([255, 216]); bytes.set(header, 2); bytes.set([255, 217], stillEnd - 2);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112], stillEnd + padding);
  return { bytes, stillEnd };
}
const primary = '<Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="8"/>';
const video = '<Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="24"/>';
const directory = (items: string) => `<Container:Directory><rdf:Seq>${items.replaceAll(/(<Container:Item[^>]*\/>)/g, "<rdf:li>$1</rdf:li>")}</rdf:Seq></Container:Directory>`;

describe("modern Motion Photo directory", () => {
  it("extracts the primary still with declared padding before consulting legacy offsets", () => {
    const { bytes, stillEnd } = fixture(directory(primary + video));
    expect(detectMotionPhoto(bytes)).toEqual({ stillEnd });
  });
  it("rejects noncompliant resources placed after MotionPhoto", () => {
    const other = '<Container:Item Item:Mime="application/octet-stream" Item:Semantic="Other" Item:Length="12" Item:Padding="4"/>';
    const { bytes } = fixture(directory(primary + video + other), 8, 16);
    expect(detectMotionPhoto(bytes)).toBeNull();
  });
  it("resolves arbitrary namespace aliases by URI", () => {
    const { bytes, stillEnd } = fixture(directory(primary + video), 8, 0, "1", true);
    expect(detectMotionPhoto(bytes)).toEqual({ stillEnd });
  });
  it.each(["0", "-1", "2"])("modern %s overrides legacy enabled metadata", (flag) => {
    const { bytes } = fixture(directory(primary + video), 8, 0, flag);
    expect(detectMotionPhoto(bytes)).toBeNull();
    expect(hasMotionPhotoMetadata(bytes)).toBe(false);
  });
  it("disabled modern metadata overrides even duplicate deprecated enabled flags", () => {
    const { bytes } = fixture(directory(primary + video) + '<Meta GCamera:MicroVideo="1"/>', 8, 0, "0");
    expect(hasMotionPhotoMetadata(bytes)).toBe(false);
    expect(detectMotionPhoto(bytes)).toBeNull();
  });
  it("supports shared secondary resources of length zero before the last video", () => {
    const shared = '<Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="0"/>';
    const { bytes, stillEnd } = fixture(directory(primary + shared + video));
    expect(detectMotionPhoto(bytes)).toEqual({ stillEnd });
  });
  it.each([
    directory(primary + '<Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/>' + video),
    directory(primary + video.replace(' Item:Mime="video/mp4"', '')),
    directory(primary + '<Container:Item Item:Mime="image/jpeg" Item:Length="0"/>' + video),
    directory(primary + video.replace('/>', ' Item:Padding="0"/>')),
  ])("rejects invalid required/unique fields or secondary padding: %s", (xml) => {
    expect(detectMotionPhoto(fixture(xml).bytes)).toBeNull();
  });
  it("supports directory-based Xiaomi media carrying only the legacy enabled flag", () => {
    const { bytes, stillEnd } = fixture(directory(primary + video));
    const text = new TextDecoder().decode(bytes);
    const start = text.indexOf('Camera:MotionPhoto="1"');
    bytes.fill(32, start, start + 'Camera:MotionPhoto="1"'.length);
    expect(detectMotionPhoto(bytes)).toEqual({ stillEnd });
  });
  it("rejects an impossible MP4 box size even when the type and offset match", () => {
    const { bytes, stillEnd } = fixture(directory(primary + video));
    bytes.set([0, 0, 4, 0], stillEnd + 8);
    expect(detectMotionPhoto(bytes)).toBeNull();
  });
  it.each([
    directory(primary + video.replace('Length="24"', 'Length="999999"')),
    directory(primary + video.replace('Length="24"', 'Length="-1"')),
    directory(primary + video.replace('Length="24"', 'Length="oops"')),
    directory(primary + video.replace('Semantic="MotionPhoto"', 'Semantic="Other"')),
    '<Container:Directory>truncated',
    '',
  ])("never accepts a usable legacy offset when modern metadata is malformed: %s", (metadata) => {
    expect(detectMotionPhoto(fixture(metadata).bytes)).toBeNull();
  });
});
