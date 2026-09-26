import { describe, it, expect } from "vitest";
import { computeSha256Hex, computeSha256HexFromBytes, createHashRegistry } from "./dedupe";

describe("dedupe", () => {
  describe("computeSha256HexFromBytes", () => {
    it("produces consistent hash for same bytes", async () => {
      const bytes1 = new Uint8Array([1, 2, 3, 4, 5]);
      const bytes2 = new Uint8Array([1, 2, 3, 4, 5]);
      const hash1 = await computeSha256HexFromBytes(bytes1);
      const hash2 = await computeSha256HexFromBytes(bytes2);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it("produces different hash for different bytes", async () => {
      const bytes1 = new Uint8Array([1, 2, 3]);
      const bytes2 = new Uint8Array([1, 2, 4]);
      const hash1 = await computeSha256HexFromBytes(bytes1);
      const hash2 = await computeSha256HexFromBytes(bytes2);
      expect(hash1).not.toBe(hash2);
    });

    it("produces different hash for same length different content", async () => {
      const bytes1 = new Uint8Array(100).fill(0);
      const bytes2 = new Uint8Array(100).fill(1);
      const hash1 = await computeSha256HexFromBytes(bytes1);
      const hash2 = await computeSha256HexFromBytes(bytes2);
      expect(hash1).not.toBe(hash2);
    });

    it("empty bytes produces valid hash", async () => {
      const bytes = new Uint8Array(0);
      const hash = await computeSha256HexFromBytes(bytes);
      expect(hash.length).toBe(64);
      // SHA-256 of empty string
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  describe("computeSha256Hex (File)", () => {
    it("computes hash from File", async () => {
      const bytes = new Uint8Array([10, 20, 30, 40, 50]);
      const file = new File([bytes], "test.bin", { type: "application/octet-stream" });
      const hash = await computeSha256Hex(file);
      expect(hash.length).toBe(64);
    });

    it("same file content produces same hash", async () => {
      const bytes = new Uint8Array([100, 200, 50, 25]);
      const file1 = new File([bytes], "a.jpg", { type: "image/jpeg" });
      const file2 = new File([bytes], "b.jpg", { type: "image/jpeg" });
      const hash1 = await computeSha256Hex(file1);
      const hash2 = await computeSha256Hex(file2);
      expect(hash1).toBe(hash2);
    });

    it("different file content produces different hash", async () => {
      const file1 = new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" });
      const file2 = new File([new Uint8Array([1, 2, 4])], "a.jpg", { type: "image/jpeg" });
      const hash1 = await computeSha256Hex(file1);
      const hash2 = await computeSha256Hex(file2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("createHashRegistry", () => {
    it("starts empty", () => {
      const registry = createHashRegistry();
      expect(registry.has("abc")).toBe(false);
    });

    it("add and has work", () => {
      const registry = createHashRegistry();
      registry.add("hash1");
      expect(registry.has("hash1")).toBe(true);
      expect(registry.has("hash2")).toBe(false);
    });

    it("delete removes hash", () => {
      const registry = createHashRegistry();
      registry.add("hash1");
      registry.delete("hash1");
      expect(registry.has("hash1")).toBe(false);
    });

    it("delete non-existent is no-op", () => {
      const registry = createHashRegistry();
      registry.delete("nonexistent");
      expect(registry.has("nonexistent")).toBe(false);
    });

    it("multiple hashes tracked independently", () => {
      const registry = createHashRegistry();
      registry.add("hash1");
      registry.add("hash2");
      registry.add("hash3");
      expect(registry.has("hash1")).toBe(true);
      expect(registry.has("hash2")).toBe(true);
      expect(registry.has("hash3")).toBe(true);
      registry.delete("hash2");
      expect(registry.has("hash1")).toBe(true);
      expect(registry.has("hash2")).toBe(false);
      expect(registry.has("hash3")).toBe(true);
    });

    it("registry instances are independent", () => {
      const reg1 = createHashRegistry();
      const reg2 = createHashRegistry();
      reg1.add("shared");
      expect(reg1.has("shared")).toBe(true);
      expect(reg2.has("shared")).toBe(false);
    });
  });
});