import { describe, expect, it } from "vitest";
import { IncrementalSha256, sha256HexOfBytes } from "./streamingHash";
import { sha256BytesHex } from "./modelTransfers";

const encoder = new TextEncoder();

function chunked(data: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < data.length) {
    const size = sizes[i % sizes.length]!;
    const end = Math.min(offset + size, data.length);
    out.push(data.slice(offset, end));
    offset = end;
    i++;
  }
  return out;
}

function hashChunked(data: Uint8Array, sizes: number[]): string {
  const hasher = new IncrementalSha256();
  for (const chunk of chunked(data, sizes)) hasher.update(chunk);
  return hasher.digestHex();
}

describe("IncrementalSha256", () => {
  it("matches NIST vectors for empty and 'abc'", () => {
    expect(new IncrementalSha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const hasher = new IncrementalSha256();
    hasher.update(encoder.encode("abc"));
    expect(hasher.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("handles padding boundaries (55/56/57/63/64/65 bytes)", () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 128]) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i++) data[i] = (i * 31 + 7) & 0xff;
      expect(hashChunked(data, [1])).toBe(sha256BytesHex(data));
      expect(hashChunked(data, [7])).toBe(sha256BytesHex(data));
      expect(hashChunked(data, [64])).toBe(sha256BytesHex(data));
    }
  });

  it("is order- and split-invariant on a larger fixture", () => {
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
    const expected = sha256BytesHex(data);
    expect(hashChunked(data, [1])).toBe(expected);
    expect(hashChunked(data, [7])).toBe(expected);
    expect(hashChunked(data, [63])).toBe(expected);
    expect(hashChunked(data, [64])).toBe(expected);
    expect(hashChunked(data, [65])).toBe(expected);
    expect(hashChunked(data, [1000])).toBe(expected);
  });

  it("ignores empty chunks", () => {
    const hasher = new IncrementalSha256();
    hasher.update(new Uint8Array(0));
    hasher.update(encoder.encode("abc"));
    hasher.update(new Uint8Array(0));
    expect(hasher.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects use after finalize", () => {
    const hasher = new IncrementalSha256();
    hasher.update(encoder.encode("abc"));
    hasher.digestHex();
    expect(() => hasher.update(encoder.encode("x"))).toThrow();
    expect(() => hasher.digestHex()).toThrow();
  });
});

describe("sha256HexOfBytes", () => {
  it("matches the one-shot helper on fixtures", () => {
    expect(sha256HexOfBytes(encoder.encode("abc"))).toBe(
      sha256BytesHex(encoder.encode("abc")),
    );
    expect(sha256HexOfBytes(new Uint8Array(0))).toBe(
      sha256BytesHex(new Uint8Array(0)),
    );
  });
});
