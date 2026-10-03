#!/usr/bin/env node
/**
 * Deterministic benchmark fixture plates (F1): 512x512 PNGs with block
 * text, color swatches, shapes, clutter, and noise/blur variants, plus a
 * manifest of ground-truth expectations (words, colors, shapes) for
 * OCR-accuracy and hallucination scoring.
 *
 * No binaries in git: plates generate into `build/bench-fixtures/` (gitignored)
 * via `node tools/bench/gen-fixtures.mjs`. Seeded PRNG — byte-identical
 * across runs and hosts. No external dependencies (manual PNG encoding
 * over node:zlib; embedded 5x7 block font).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const OUT_DIR = join(REPO_ROOT, "build", "bench-fixtures");

const W = 512;
const H = 512;

// 5x7 block font: A-Z, 0-9, space and a few punctuation marks. Each glyph
// is 7 rows of 5 bits stored as 7 bytes.
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x13, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x19, 0x15, 0x13, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
};

/** Deterministic xorshift32 PRNG (fixed seeds → identical plates). */
function prng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function makeCanvas(bg) {
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }
  return px;
}

function setPixel(px, x, y, color) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = color[0];
  px[i + 1] = color[1];
  px[i + 2] = color[2];
}

function fillRect(px, x0, y0, x1, y1, color) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) setPixel(px, x, y, color);
  }
}

function drawText(px, text, x0, y0, scale, color) {
  let x = x0;
  const upper = String(text).toUpperCase();
  for (const ch of upper) {
    const glyph = FONT[ch] ?? FONT["?"];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((glyph[row] >> (4 - col)) & 1) {
          fillRect(px, x + col * scale, y0 + row * scale, x + col * scale + scale, y0 + row * scale + scale, color);
        }
      }
    }
    x += 6 * scale;
  }
  return x;
}

function drawCircle(px, cx, cy, r, color, filled) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (filled ? d <= r : Math.abs(d - r) < 3) setPixel(px, x, y, color);
    }
  }
}

function drawTriangle(px, cx, cy, r, color) {
  for (let y = 0; y < r * 2; y++) {
    const half = (y / (r * 2)) * r;
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      setPixel(px, x, Math.floor(cy - r + y), color);
    }
  }
}

function addNoise(px, rand, amount) {
  for (let i = 0; i < W * H * 3; i++) {
    const dart = Math.floor(rand() * 256);
    if (dart < amount) px[i] = Math.floor(rand() * 256);
  }
}

function boxBlur(px) {
  const src = Buffer.from(px);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * W + (x + dx)) * 3 + c];
        }
        px[(y * W + x) * 3 + c] = Math.round(sum / 9);
      }
    }
  }
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const RED = [220, 30, 30];
const GREEN = [30, 160, 60];
const BLUE = [30, 80, 220];
const YELLOW = [235, 200, 30];
const GRAY = [200, 200, 200];

/** Plate builders: each returns { pixels, truth }. */
const PLATES = {
  "ocr-object-umbrella": () => {
    const px = makeCanvas(WHITE);
    drawText(px, "RED UMBRELLA", 40, 60, 8, BLACK);
    drawText(px, "LOST AND FOUND", 40, 180, 5, BLACK);
    // Stylized umbrella: semicircle canopy + handle.
    for (let a = 0; a <= 180; a += 2) {
      const rad = (a * Math.PI) / 180;
      for (let r = 60; r <= 130; r += 3) {
        setPixel(px, Math.round(256 + r * Math.cos(Math.PI + rad)), Math.round(360 - r * Math.sin(rad)), RED);
      }
    }
    fillRect(px, 252, 360, 260, 470, BLACK);
    return {
      px,
      truth: {
        kind: "ocr-object",
        words: ["RED", "UMBRELLA", "LOST", "AND", "FOUND"],
        colors: ["red", "black", "white"],
        shapes: ["umbrella-canopy"],
      },
    };
  },
  "ocr-keys-lanyard": () => {
    const px = makeCanvas(WHITE);
    drawText(px, "KEYS BLUE", 40, 60, 8, BLUE);
    drawText(px, "LANYARD 04", 40, 180, 5, BLACK);
    fillRect(px, 60, 300, 452, 330, BLUE);
    drawCircle(px, 256, 400, 45, YELLOW, false);
    return {
      px,
      truth: {
        kind: "ocr-object",
        words: ["KEYS", "BLUE", "LANYARD", "04"],
        colors: ["blue", "yellow", "black", "white"],
        shapes: ["key-ring"],
      },
    };
  },
  "ocr-brand-decoy": () => {
    const px = makeCanvas(WHITE);
    drawText(px, "ZORBLE", 60, 80, 10, BLACK);
    drawText(px, "SPORT DRINK", 60, 220, 5, BLACK);
    drawText(px, "NOT A REAL BRAND", 60, 300, 4, BLACK);
    fillRect(px, 60, 380, 452, 430, GREEN);
    return {
      px,
      truth: {
        kind: "brand-decoy",
        words: ["ZORBLE", "SPORT", "DRINK", "NOT", "A", "REAL", "BRAND"],
        colors: ["green", "black", "white"],
        shapes: [],
        forbiddenClaims: ["Nike", "Adidas", "Coca-Cola", "Pepsi", "Champion"],
      },
    };
  },
  "swatch-primary": () => {
    const px = makeCanvas(WHITE);
    fillRect(px, 30, 30, 240, 240, RED);
    fillRect(px, 272, 30, 482, 240, GREEN);
    fillRect(px, 30, 272, 240, 482, BLUE);
    fillRect(px, 272, 272, 482, 482, YELLOW);
    drawText(px, "RED GREEN BLUE YELLOW", 30, 490 - 35, 3, BLACK);
    return {
      px,
      truth: {
        kind: "swatch",
        words: ["RED", "GREEN", "BLUE", "YELLOW"],
        colors: ["red", "green", "blue", "yellow"],
        shapes: ["quadrants"],
      },
    };
  },
  "shapes-outline": () => {
    const px = makeCanvas(WHITE);
    drawCircle(px, 130, 200, 90, RED, false);
    drawTriangle(px, 360, 200, 90, BLUE);
    fillRect(px, 150, 340, 362, 450, GREEN);
    return {
      px,
      truth: {
        kind: "shapes",
        words: [],
        colors: ["red", "blue", "green", "white"],
        shapes: ["circle", "triangle", "rectangle"],
      },
    };
  },
  "clutter-grid": () => {
    const px = makeCanvas(GRAY);
    const rand = prng(20261003);
    const colors = [RED, GREEN, BLUE, YELLOW, BLACK];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const x = 30 + col * 120;
        const y = 30 + row * 120;
        const pick = colors[Math.floor(rand() * colors.length)];
        if (rand() < 0.5) fillRect(px, x, y, x + 90, y + 90, pick);
        else drawCircle(px, x + 45, y + 45, 42, pick, false);
      }
    }
    drawText(px, "CLUTTER 16", 120, 470 - 30, 4, BLACK);
    return {
      px,
      truth: {
        kind: "clutter",
        words: ["CLUTTER", "16"],
        colors: ["red", "green", "blue", "yellow", "black", "gray"],
        shapes: ["mixed-grid"],
      },
    };
  },
  "ocr-noisy": () => {
    const base = PLATES["ocr-object-umbrella"]();
    addNoise(base.px, prng(77), 26);
    return {
      px: base.px,
      truth: { ...base.truth, kind: "ocr-noisy", noiseSeed: 77 },
    };
  },
  "ocr-blur": () => {
    const base = PLATES["ocr-keys-lanyard"]();
    boxBlur(base.px);
    return {
      px: base.px,
      truth: { ...base.truth, kind: "ocr-blur" },
    };
  },
};

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal 8-bit RGB PNG: signature + IHDR + zlib IDAT + IEND. */
function encodePng(px) {
  const stride = W * 3 + 1;
  const raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    px.copy(raw, y * stride + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { version: 1, plates: {} };
  for (const [id, build] of Object.entries(PLATES)) {
    const { px, truth } = build();
    const png = encodePng(px);
    const file = `${id}.png`;
    writeFileSync(join(OUT_DIR, file), png);
    manifest.plates[id] = { file, bytes: png.length, ...truth };
    console.log(`plate ${id}: ${file} (${png.length} bytes)`);
  }
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: ${Object.keys(PLATES).length} plates`);
}

main();
