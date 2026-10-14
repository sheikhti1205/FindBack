// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  pickEmoji: vi.fn(),
  platform: "android" as string,
  available: true,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isPluginAvailable: () => native.available,
  },
  registerPlugin: () => native,
}));

import {
  EMOJI_WEB_FALLBACK,
  isNativeEmojiAvailable,
  pickNativeEmoji,
  sanitizePickedEmoji,
} from "./emojiPicker";

beforeEach(() => {
  vi.clearAllMocks();
  native.platform = "android";
  native.available = true;
  native.pickEmoji.mockResolvedValue({ emoji: "🔥" });
});

describe("isNativeEmojiAvailable (FBX-016 bridge contract)", () => {
  it("is true only in the Android app with the bridge registered", () => {
    expect(isNativeEmojiAvailable()).toBe(true);
    native.platform = "web";
    expect(isNativeEmojiAvailable()).toBe(false);
    native.platform = "android";
    native.available = false;
    expect(isNativeEmojiAvailable()).toBe(false);
  });
});

describe("sanitizePickedEmoji", () => {
  it("accepts a single pick, including multi-codepoint sequences", () => {
    expect(sanitizePickedEmoji("🔥")).toBe("🔥");
    // Flag (regional indicators), skin tone, ZWJ family.
    expect(sanitizePickedEmoji("🇺🇸")).toBe("🇺🇸");
    expect(sanitizePickedEmoji("👍🏽")).toBe("👍🏽");
    expect(sanitizePickedEmoji("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("rejects blanks, runs, URLs, and data payloads (no text injection)", () => {
    expect(sanitizePickedEmoji("")).toBeNull();
    expect(sanitizePickedEmoji("   ")).toBeNull();
    expect(sanitizePickedEmoji(null)).toBeNull();
    expect(sanitizePickedEmoji(undefined)).toBeNull();
    expect(sanitizePickedEmoji(42)).toBeNull();
    expect(sanitizePickedEmoji("😀 😀")).toBeNull();
    expect(sanitizePickedEmoji("https://evil.example/x.png")).toBeNull();
    expect(sanitizePickedEmoji("data:image/png;base64,AAA")).toBeNull();
    expect(sanitizePickedEmoji("x".repeat(25))).toBeNull();
  });
});

describe("pickNativeEmoji", () => {
  it("resolves the sanitized pick from the native sheet", async () => {
    await expect(pickNativeEmoji()).resolves.toBe("🔥");
    expect(native.pickEmoji).toHaveBeenCalledTimes(1);
  });

  it("resolves null on cancel without touching any fallback", async () => {
    native.pickEmoji.mockResolvedValue({ cancelled: true });
    await expect(pickNativeEmoji()).resolves.toBeNull();
  });

  it("resolves null (never throws) when the bridge is missing or fails", async () => {
    native.platform = "web";
    await expect(pickNativeEmoji()).resolves.toBeNull();
    expect(native.pickEmoji).not.toHaveBeenCalled();
    native.platform = "android";
    native.pickEmoji.mockRejectedValue(new Error("bridge down"));
    await expect(pickNativeEmoji()).resolves.toBeNull();
  });

  it("resolves null for a malformed bridge payload", async () => {
    native.pickEmoji.mockResolvedValue({ emoji: "https://evil.example/x.png" });
    await expect(pickNativeEmoji()).resolves.toBeNull();
    native.pickEmoji.mockResolvedValue({});
    await expect(pickNativeEmoji()).resolves.toBeNull();
  });
});

describe("EMOJI_WEB_FALLBACK", () => {
  it("is a catalogue-derived alias (the full catalogue is the picker)", () => {
    expect(EMOJI_WEB_FALLBACK.length).toBeGreaterThan(150);
    for (const emoji of EMOJI_WEB_FALLBACK) {
      expect(sanitizePickedEmoji(emoji)).toBe(emoji);
    }
    expect(EMOJI_WEB_FALLBACK).toContain("🔥");
  });
});
