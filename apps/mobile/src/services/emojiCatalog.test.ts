// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMOJI_CATALOG,
  EMOJI_CATEGORIES,
  isKnownCatalogEmoji,
  loadEmojiRecents,
  recordEmojiRecent,
  searchEmojiCatalog,
} from "./emojiCatalog";
import { sanitizePickedEmoji } from "./emojiPicker";

beforeEach(() => {
  globalThis.localStorage?.clear();
});

describe("EMOJI_CATEGORIES", () => {
  it("covers smileys, gestures, hearts, nature, food, activities, travel, objects, symbols, and flags", () => {
    expect(EMOJI_CATEGORIES.map((c) => c.id)).toEqual([
      "smileys",
      "gestures",
      "hearts",
      "nature",
      "food",
      "activities",
      "travel",
      "objects",
      "symbols",
      "flags",
    ]);
    for (const category of EMOJI_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.items.length).toBeGreaterThan(5);
    }
  });

  it("is a complete picker dataset, not a tiny stub", () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(150);
    const chars = EMOJI_CATALOG.map((e) => e.char);
    expect(new Set(chars).size).toBe(chars.length);
    // Every entry survives the bridge sanitizer (single visible pick).
    for (const entry of EMOJI_CATALOG) {
      expect(sanitizePickedEmoji(entry.char)).toBe(entry.char);
    }
  });

  it("includes skin-tone variants, ZWJ sequences, and flags", () => {
    expect(isKnownCatalogEmoji("👍🏽")).toBe(true);
    expect(isKnownCatalogEmoji("👏🏿")).toBe(true);
    expect(isKnownCatalogEmoji("🙏🏻")).toBe(true);
    expect(isKnownCatalogEmoji("👨‍👩‍👧")).toBe(true);
    expect(isKnownCatalogEmoji("🇧🇩")).toBe(true);
    expect(isKnownCatalogEmoji("🏳️‍🌈")).toBe(true);
    expect(isKnownCatalogEmoji("not-an-emoji")).toBe(false);
  });
});

describe("searchEmojiCatalog", () => {
  it("finds entries by keyword, name, or char", () => {
    expect(searchEmojiCatalog("fire").map((e) => e.char)).toContain("🔥");
    expect(searchEmojiCatalog("pray").map((e) => e.char)).toContain("🙏");
    expect(searchEmojiCatalog("BIRTHDAY").map((e) => e.char)).toContain("🎂");
    expect(searchEmojiCatalog("🇧🇩").map((e) => e.char)).toContain("🇧🇩");
  });

  it("returns nothing for empty queries and caps runaway result sets", () => {
    expect(searchEmojiCatalog("")).toEqual([]);
    expect(searchEmojiCatalog("   ")).toEqual([]);
    expect(searchEmojiCatalog("a", 5).length).toBeLessThanOrEqual(5);
    expect(searchEmojiCatalog("zzz-no-such-emoji")).toEqual([]);
  });
});

describe("emoji recents", () => {
  it("starts empty and records picks most-recent-first (deduped, capped)", () => {
    expect(loadEmojiRecents()).toEqual([]);
    recordEmojiRecent("🔥");
    recordEmojiRecent("❤️");
    expect(loadEmojiRecents()).toEqual(["❤️", "🔥"]);
    recordEmojiRecent("🔥");
    expect(loadEmojiRecents()).toEqual(["🔥", "❤️"]);
  });

  it("never stores arbitrary text, URLs, or payloads", () => {
    recordEmojiRecent("🔥");
    recordEmojiRecent("https://evil.example/x.png");
    recordEmojiRecent("hello world");
    recordEmojiRecent("x".repeat(30));
    expect(loadEmojiRecents()).toEqual(["🔥"]);
  });

  it("accepts multi-codepoint picks (tones, ZWJ, flags)", () => {
    recordEmojiRecent("👍🏽");
    recordEmojiRecent("👨‍👩‍👧");
    recordEmojiRecent("🇧🇩");
    expect(loadEmojiRecents()).toEqual(["🇧🇩", "👨‍👩‍👧", "👍🏽"]);
  });
});
