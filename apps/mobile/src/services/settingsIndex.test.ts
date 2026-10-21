// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX, searchSettings } from "./settingsIndex";

describe("settingsIndex", () => {
  it("covers every settings row target from route_map.csv", () => {
    const routes = SETTINGS_INDEX.map((entry) => entry.route).sort();
    expect(routes).toEqual(
      [
        "/settings/about",
        "/settings/accessibility",
        "/settings/account",
        "/settings/ai",
        "/settings/ai/connections",
        "/settings/appearance",
        "/settings/diagnostics",
        // CF-010 (packet `09` §6, §23): the feed layout preference is a settings
        // row like the others. It postdates the 2026-10-03 route map this test
        // was written against.
        "/settings/feed-layout",
        // Local intelligence (packet `07` §1/§6) is the consumer owner of the
        // on-device local tools; it also postdates that route map.
        "/settings/local-intelligence",
        // The consumer AI screens added with the cloud-only Chat and the
        // local-download owner; they postdate that route map too.
        "/settings/local-intelligence/downloads",
        "/settings/ai/chat-models",
        "/settings/ai/models",
        "/settings/help",
        "/settings/media",
        "/settings/notifications",
        "/settings/privacy",
        // The three consumer documents. They postdate the 2026-10-03 route map
        // this test was written against, like the local-intelligence rows.
        "/settings/terms",
        "/settings/privacy-policy",
        "/settings/community-guidelines",
        "/onboarding?replay=1",
      ].sort(),
    );
  });

  it("finds the three legal documents by the words a reader would type", () => {
    expect(searchSettings("terms").map((r) => r.id)).toContain("terms");
    expect(searchSettings("guidelines").map((r) => r.id)).toContain("community-guidelines");
    expect(searchSettings("privacy policy").map((r) => r.id)).toContain("privacy-policy");
  });

  it("matches alias terms from settings_search_index.csv", () => {
    // theme -> Appearance
    expect(searchSettings("theme").map((r) => r.id)).toContain("appearance");
    // text size -> Accessibility
    expect(searchSettings("text size").map((r) => r.id)).toContain("accessibility");
    // key -> Cloud connections
    expect(searchSettings("key").map((r) => r.id)).toContain("connections");
    // version/build -> About
    expect(searchSettings("version").map((r) => r.id)).toContain("about");
    // push -> Notifications
    expect(searchSettings("push").map((r) => r.id)).toContain("notifications");
    // photo quality -> Media
    expect(searchSettings("photo quality").map((r) => r.id)).toContain("media");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(searchSettings("  THEME ").map((r) => r.id)).toContain("appearance");
    expect(searchSettings("Ai").map((r) => r.id)).toEqual(
      expect.arrayContaining(["ai", "connections"]),
    );
  });

  it("returns no matches for unknown terms", () => {
    expect(searchSettings("zxqv-nonexistent")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("attaches a group path hint to every result", () => {
    for (const result of searchSettings("a")) {
      expect(typeof result.description).toBe("string");
      expect((result.description as string).length).toBeGreaterThan(0);
    }
  });

  it("groups entries under the W4 root structure", () => {
    const groups = new Map(SETTINGS_INDEX.map((entry) => [entry.id, entry.group]));
    expect(groups.get("account")).toBe("Account");
    for (const id of ["appearance", "accessibility", "notifications"]) {
      expect(groups.get(id)).toBe("Preferences");
    }
    for (const id of ["ai", "connections"]) {
      expect(groups.get(id)).toBe("Intelligence");
    }
    expect(groups.get("privacy")).toBe("Privacy");
    for (const id of ["media", "diagnostics"]) {
      expect(groups.get(id)).toBe("Advanced");
    }
    for (const id of ["help", "replay", "about"]) {
      expect(groups.get(id)).toBe("Help & about");
    }
  });
});
