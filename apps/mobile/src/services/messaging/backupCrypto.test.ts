// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BACKUP_CRYPTO_VERSION,
  BackupCryptoError,
  backupKeyHex,
  hex,
  importBackupKey,
  openBackupObject,
  sealBackupObject,
  sha256Hex,
} from "./backupCrypto";

const GEN = "00000000-0000-4000-9c01-000000000001";
const OTHER_GEN = "00000000-0000-4000-9c01-000000000002";
const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const NAME = "norfold.chunk.00000000-0000-4000-9c01-000000000010."
  + `${"11".repeat(32)}.v1.bin`;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

describe("the backup account key", () => {
  it("imports a 32-byte hex key as a non-extractable AES-GCM key", async () => {
    const key = await importBackupKey(GEN, KEY);
    expect(key.generation).toBe(GEN);
    expect(key.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.key.extractable).toBe(false);
    expect(key.key.usages.sort()).toEqual(["decrypt", "encrypt"]);
    await expect(crypto.subtle.exportKey("raw", key.key)).rejects.toThrow();
  });

  it("refuses anything that is not exactly 64 lowercase hex characters", async () => {
    for (const value of [undefined, null, "", "AB".repeat(32), KEY.slice(2), `${KEY}00`, "zz".repeat(32)]) {
      await expect(importBackupKey(GEN, value)).rejects.toMatchObject({ code: "backup: invalid key" });
    }
    expect(() => backupKeyHex("not-hex")).toThrow(BackupCryptoError);
  });

  it("requires a real generation id, because the AAD binds it", async () => {
    for (const generation of [undefined, "", "gen-1", GEN.toUpperCase()]) {
      await expect(importBackupKey(generation, KEY)).rejects.toMatchObject({ code: "backup: invalid key" });
    }
  });
});

describe("sealing one backup object", () => {
  it("round-trips the payload and frames it as version + IV + ciphertext", async () => {
    const key = await importBackupKey(GEN, KEY);
    const sealed = await sealBackupObject(key, NAME, bytes("hello"));
    const framed = new Uint8Array(sealed);
    expect(framed[0]).toBe(BACKUP_CRYPTO_VERSION);
    expect(framed.byteLength).toBe(1 + 12 + 5 + 16);
    expect(text(framed).includes("hello")).toBe(false);
    await expect(openBackupObject(key, NAME, sealed)).resolves.toEqual(bytes("hello"));
  });

  it("uses a fresh IV per seal, so equal payloads never produce equal bytes", async () => {
    const key = await importBackupKey(GEN, KEY);
    const first = new Uint8Array(await sealBackupObject(key, NAME, bytes("same")));
    const second = new Uint8Array(await sealBackupObject(key, NAME, bytes("same")));
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(await openBackupObject(key, NAME, first.buffer as ArrayBuffer)).toEqual(bytes("same"));
  });

  it("fails closed for a wrong key, another generation, or a moved object", async () => {
    const key = await importBackupKey(GEN, KEY);
    const sealed = await sealBackupObject(key, NAME, bytes("history"));
    const cases = [
      { key: await importBackupKey(GEN, OTHER_KEY), name: NAME },
      { key: await importBackupKey(OTHER_GEN, KEY), name: NAME },
      { key, name: "norfold.manifest.v1.bin" },
    ];
    for (const entry of cases) {
      await expect(openBackupObject(entry.key, entry.name, sealed))
        .rejects.toMatchObject({ code: "backup: decryption failed" });
    }
  });

  it("rejects tampering with the tag, the version byte, or a truncated frame", async () => {
    const key = await importBackupKey(GEN, KEY);
    const sealed = new Uint8Array(await sealBackupObject(key, NAME, bytes("history")));
    const flipped = sealed.slice();
    flipped[flipped.length - 1]! ^= 0x01;
    await expect(openBackupObject(key, NAME, flipped.buffer as ArrayBuffer))
      .rejects.toMatchObject({ code: "backup: decryption failed" });

    const version = sealed.slice();
    version[0] = BACKUP_CRYPTO_VERSION + 1;
    await expect(openBackupObject(key, NAME, version.buffer as ArrayBuffer))
      .rejects.toMatchObject({ code: "backup: invalid payload" });

    await expect(openBackupObject(key, NAME, sealed.slice(0, 20).buffer as ArrayBuffer))
      .rejects.toMatchObject({ code: "backup: invalid payload" });
  });

  it("refuses an empty payload and an unusable object name", async () => {
    const key = await importBackupKey(GEN, KEY);
    await expect(sealBackupObject(key, NAME, new Uint8Array(0)))
      .rejects.toMatchObject({ code: "backup: invalid payload" });
    for (const name of ["", "x".repeat(201), "bad\u0000name", "line\nbreak"]) {
      await expect(sealBackupObject(key, name, bytes("x")))
        .rejects.toMatchObject({ code: "backup: invalid payload" });
    }
  });

  it("never invents a key when the platform has no WebCrypto", async () => {
    const empty = { getRandomValues: (array: Uint8Array) => array } as unknown as Crypto;
    await expect(importBackupKey(GEN, KEY, empty)).rejects.toMatchObject({ code: "backup: invalid key" });
  });
});

describe("backup digests", () => {
  it("is the standard SHA-256 of the bytes", async () => {
    expect(await sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});
