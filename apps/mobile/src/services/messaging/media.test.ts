// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  copyMediaMetadata, isMediaEvictable, isMediaProtected, MEDIA_BUDGET_BYTES, MEDIA_MAX_BYTES,
  sameMediaIdentity, sha256Hex, verifyMediaBytes, type MediaMetadata,
} from "./media";

const ATT = "00000000-0000-4000-9100-000000000001";
const MSG = "00000000-0000-4000-9100-000000000002";
/** SHA-256 of the ASCII bytes "abc". */
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function metadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    id: ATT,
    messageId: MSG,
    direction: "OUT",
    sha256: ABC,
    mime: "image/jpeg",
    byteSize: 3,
    width: 1200,
    height: 900,
    expiresAt: null,
    ...overrides,
  };
}

function abc(): ArrayBuffer {
  return new Uint8Array([0x61, 0x62, 0x63]).buffer;
}

describe("media metadata", () => {
  it("copies a valid record into a fresh object", () => {
    const input = metadata();
    const copied = copyMediaMetadata(input);
    expect(copied).toEqual(input);
    expect(copied).not.toBe(input);
  });

  it("accepts every container the gateway accepts and nothing else", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp"] as const) {
      expect(copyMediaMetadata(metadata({ mime })).mime).toBe(mime);
    }
    for (const mime of ["image/gif", "image/bmp", "image/heic", "image/svg+xml", "text/plain"]) {
      expect(() => copyMediaMetadata({ ...metadata(), mime })).toThrow("Unsupported media type");
    }
  });

  it("rejects a digest that is not lowercase hex of the right length", () => {
    for (const sha256 of [ABC.toUpperCase(), ABC.slice(1), `${ABC}0`, "z".repeat(64), ""]) {
      expect(() => copyMediaMetadata({ ...metadata(), sha256 })).toThrow("Invalid media digest");
    }
  });

  it("bounds byte size and dimensions to what the server and the decoder allow", () => {
    expect(copyMediaMetadata(metadata({ byteSize: MEDIA_MAX_BYTES })).byteSize).toBe(MEDIA_MAX_BYTES);
    expect(() => copyMediaMetadata(metadata({ byteSize: MEDIA_MAX_BYTES + 1 }))).toThrow("Invalid media byte size");
    expect(() => copyMediaMetadata(metadata({ byteSize: 0 }))).toThrow("Invalid media byte size");
    expect(() => copyMediaMetadata(metadata({ byteSize: 1.5 }))).toThrow("Invalid media byte size");
    expect(() => copyMediaMetadata(metadata({ width: 0 }))).toThrow("Invalid media width");
    expect(() => copyMediaMetadata(metadata({ height: 8193 }))).toThrow("Invalid media height");
  });

  it("treats expiry as optional but never as an arbitrary number", () => {
    expect(copyMediaMetadata(metadata({ expiresAt: 1_700_000_000_000 })).expiresAt).toBe(1_700_000_000_000);
    expect(copyMediaMetadata(metadata({ expiresAt: null })).expiresAt).toBeNull();
    expect(copyMediaMetadata({ ...metadata(), expiresAt: undefined }).expiresAt).toBeNull();
    for (const expiresAt of [0, -1, 1.5, Number.NaN, "1700"]) {
      expect(() => copyMediaMetadata({ ...metadata(), expiresAt })).toThrow("Invalid media expiry");
    }
  });

  it("rejects a malformed id, message id or direction", () => {
    expect(() => copyMediaMetadata(metadata({ id: "not-a-uuid" }))).toThrow("Invalid messaging UUID");
    expect(() => copyMediaMetadata(metadata({ messageId: "00000000-0000-4000-9100-00000000000A" })))
      .toThrow("Invalid messaging UUID");
    expect(() => copyMediaMetadata({ ...metadata(), direction: "SIDEWAYS" })).toThrow("Invalid media direction");
    expect(() => copyMediaMetadata(null)).toThrow("Invalid media metadata");
  });

  it("treats expiry as mutable identity and everything else as immutable", () => {
    const base = metadata();
    expect(sameMediaIdentity(base, metadata({ expiresAt: 123 }))).toBe(true);
    for (const changed of [
      metadata({ id: MSG }), metadata({ messageId: ATT }), metadata({ direction: "IN" }),
      metadata({ sha256: "0".repeat(64) }), metadata({ mime: "image/png" }),
      metadata({ byteSize: 4 }), metadata({ width: 1 }), metadata({ height: 1 }),
    ]) {
      expect(sameMediaIdentity(base, changed)).toBe(false);
    }
  });

  it("protects everything that is not a committed, acknowledged remote copy", () => {
    for (const state of ["QUEUED", "UPLOADING", "FAILED", "AWAITING_ACK", "EVICTED"] as const) {
      expect(isMediaProtected(state)).toBe(true);
      expect(isMediaEvictable(state)).toBe(false);
    }
    expect(isMediaProtected("READY")).toBe(false);
    expect(isMediaEvictable("READY")).toBe(true);
  });

  it("publishes the owner-approved budget and the transport ceiling", () => {
    expect(MEDIA_BUDGET_BYTES).toBe(100 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("media bytes verification", () => {
  it("computes the documented SHA-256 vector", async () => {
    expect(await sha256Hex(abc())).toBe(ABC);
  });

  it("accepts exactly the declared length and digest", async () => {
    await expect(verifyMediaBytes(metadata(), abc())).resolves.toBeUndefined();
  });

  it("refuses a length mismatch before hashing", async () => {
    await expect(verifyMediaBytes(metadata({ byteSize: 4 }), abc())).rejects.toThrow("Media byte length mismatch");
  });

  it("refuses a digest mismatch at the declared length", async () => {
    const wrong = new Uint8Array([0x61, 0x62, 0x64]).buffer;
    await expect(verifyMediaBytes(metadata(), wrong)).rejects.toThrow("Media digest mismatch");
  });

  it("refuses a non-buffer instead of coercing it", async () => {
    await expect(verifyMediaBytes(metadata(), new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer))
      .rejects.toThrow("Invalid media bytes");
  });
});
