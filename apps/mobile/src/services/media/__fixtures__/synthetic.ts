/**
 * Synthetic image-byte builders for media tests.
 *
 * Every builder emits a minimal but structurally valid header for its format so
 * the intake code can sniff magic bytes, probe dimensions, read EXIF
 * orientation, and detect animation without any real photo, decoder, or
 * committed binary. Payload/CRC bytes are zeroes; parsers must not rely on
 * them. Nothing here claims device or browser decoder behaviour.
 */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    out[index] = text.charCodeAt(index) & 0xff;
  }
  return out;
}

function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function pngChunk(fourcc: string, data: Uint8Array): Uint8Array {
  return concat(u32be(data.length), ascii(fourcc), data, new Uint8Array(4));
}

export function buildPng(
  width: number,
  height: number,
  options: { animated?: boolean; colorType?: number; exIfGps?: boolean } = {},
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = concat(
    u32be(width),
    u32be(height),
    new Uint8Array([8, options.colorType ?? 6, 0, 0, 0]),
  );
  const parts: Uint8Array[] = [signature, pngChunk("IHDR", ihdr)];
  if (options.exIfGps === true) {
    parts.push(pngChunk("eXIf", concat(ascii("Exif"), ascii("GPSFIX"))));
  }
  if (options.animated === true) {
    parts.push(pngChunk("acTL", concat(u32be(2), u32be(0))));
  }
  parts.push(pngChunk("IDAT", new Uint8Array([0])));
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concat(...parts);
}

export function buildGif(
  width: number,
  height: number,
  options: { animated?: boolean } = {},
): Uint8Array {
  const header = concat(
    ascii("GIF89a"),
    u16le(width),
    u16le(height),
    new Uint8Array([0x70, 0x00, 0x00]),
  );
  const frame = new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00]);
  if (options.animated !== true) {
    return concat(header, frame, new Uint8Array([0x3b]));
  }
  const netscape = concat(
    new Uint8Array([0x21, 0xff, 0x0b]),
    ascii("NETSCAPE2.0"),
    new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x00]),
  );
  return concat(header, netscape, frame, frame, new Uint8Array([0x3b]));
}

function exifPayload(orientation: number, gps: boolean): Uint8Array {
  const entries: Uint8Array[] = [];
  const orientationEntry = concat(
    u16le(0x0112),
    u16le(3),
    u32le(1),
    concat(u16le(orientation), new Uint8Array(2)),
  );
  entries.push(orientationEntry);
  // TIFF header (8) + IFD count (2) + entries + next-offset (4).
  const gpsOffset = 8 + 2 + (entries.length + (gps ? 1 : 0)) * 12 + 4;
  if (gps) {
    entries.push(concat(u16le(0x8825), u16le(4), u32le(1), u32le(gpsOffset)));
  }
  const ifd = concat(u16le(entries.length), ...entries, u32le(0));
  const tiffHeader = concat(ascii("II"), u16le(42), u32le(8));
  if (!gps) {
    return concat(ascii("Exif\0\0"), tiffHeader, ifd);
  }
  const gpsIfd = concat(
    u16le(1),
    concat(u16le(0x0000), u16le(1), u32le(4), ascii("GPS\0")),
    u32le(0),
  );
  return concat(ascii("Exif\0\0"), tiffHeader, ifd, gpsIfd);
}

export function buildJpeg(
  width: number,
  height: number,
  options: { orientation?: number; gps?: boolean } = {},
): Uint8Array {
  const exif = exifPayload(options.orientation ?? 1, options.gps ?? false);
  const app1 = concat(new Uint8Array([0xff, 0xe1]), u16be(exif.length + 2), exif);
  // Single-component SOF0: length covers 8 fixed bytes + 3 per component.
  const sof0 = concat(
    new Uint8Array([0xff, 0xc0]),
    u16be(11),
    new Uint8Array([8]),
    u16be(height),
    u16be(width),
    new Uint8Array([1, 1, 0x11, 0]),
  );
  const sos = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00]);
  return concat(new Uint8Array([0xff, 0xd8]), app1, sof0, sos, new Uint8Array([0xff, 0xd9]));
}

function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 1 ? concat(data, new Uint8Array(1)) : data;
  return concat(ascii(fourcc), u32le(data.length), padded);
}

function u24le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
}

export function buildWebp(
  width: number,
  height: number,
  options: { animated?: boolean; exifGps?: boolean } = {},
): Uint8Array {
  let flags = 0;
  if (options.animated === true) flags |= 0x02;
  if (options.exifGps === true) flags |= 0x08;
  const vp8x = webpChunk(
    "VP8X",
    concat(new Uint8Array([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)),
  );
  const chunks: Uint8Array[] = [vp8x];
  if (options.exifGps === true) {
    chunks.push(webpChunk("EXIF", ascii("GPSFIX")));
  }
  if (options.animated === true) {
    chunks.push(webpChunk("ANMF", new Uint8Array(16)));
  } else {
    chunks.push(webpChunk("VP8 ", new Uint8Array([0x9d, 0x01, 0x2a])));
  }
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
}

export function buildBmp(width: number, height: number): Uint8Array {
  const pixelData = new Uint8Array(4);
  const header = concat(
    ascii("BM"),
    u32le(54 + pixelData.length),
    new Uint8Array(4),
    u32le(54),
    u32le(40),
    u32le(width),
    u32le(height),
    u16le(1),
    u16le(24),
  );
  const padding = new Uint8Array(54 - header.length);
  return concat(header, padding, pixelData);
}

export function buildAvifFtyp(): Uint8Array {
  const body = concat(ascii("ftyp"), ascii("avif"), u32le(0), ascii("avif"), ascii("mif1"));
  return concat(u32be(body.length + 4), body);
}

export function buildHeicFtyp(): Uint8Array {
  const body = concat(ascii("ftyp"), ascii("heic"), u32le(0), ascii("heic"), ascii("mif1"));
  return concat(u32be(body.length + 4), body);
}

export function buildTiff(): Uint8Array {
  return concat(ascii("II"), u16le(42), u32le(8), u16le(0), u32le(0));
}
