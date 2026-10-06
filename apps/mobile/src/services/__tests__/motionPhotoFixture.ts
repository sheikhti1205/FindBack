import { Buffer } from "node:buffer";

// Own synthetic black 16x16 JPEG + one-frame MPEG-4/MP4, generated with ffmpeg
// lavfi color=c=black:s=16x16:r=1, -frames:v 1 -threads 1. No vendor/user bytes.
// JPEG: -c:v mjpeg -f image2pipe. Video: -c:v mpeg4 -flags +bitexact
// -map_metadata -1 -movflags frag_keyframe+empty_moov -f mp4.
const JPEG = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AB//Z";
const MP4 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc282aXNvMm1wNDEAAAMbbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAh50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAG6bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAA2XN0c2QAAAAAAAAAAQAAAMltcDR2AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABCkxhdmMgbXBlZzQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAT2VzZHMAAAAAA4CAgD4AAQAEgICAMCARAAAAAAMNQAADDUAFgICAHgAAAbABAAABtYkTAAABAAAAASAAxI2IAA0AhAIUYwaAgIABAgAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAw1AAAMNQAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDMAAABwbW9vZgAAABBtZmhkAAAAAAAAAAEAAABYdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADOwAAQAAAAAARAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHgCAAAAAAAAGW1kYXQAAAGzABAHAAABthYFGCPbfgAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADOwEBAQAAABBtZnJvAAAAAAAAAEM=";

/** Fixed encoded payloads; fresh deterministic container each invocation. */
export function generatedMotionPhoto(padBytes = 8): {
  bytes: Uint8Array; stillEnd: number; mp4Start: number; video: Uint8Array;
} {
  const jpeg = Buffer.from(JPEG, "base64");
  const video = Buffer.from(MP4, "base64");
  // APP1's big-endian segment length includes its two length bytes, not the
  // marker. Offset counts the MP4 from EOF, excluding the short zero pad.
  const xmp = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" ' +
    `GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${video.length}"/>` +
    '</rdf:RDF></x:xmpmeta>',
    "utf8",
  );
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(xmp.length + 2, 2);
  const still = Buffer.concat([jpeg.subarray(0, 2), app1, xmp, jpeg.subarray(2)]);
  const padding = new Uint8Array(padBytes);
  return {
    bytes: Buffer.concat([still, padding, video]),
    stillEnd: still.length,
    mp4Start: still.length + padBytes,
    video,
  };
}
