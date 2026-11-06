import { describe, expect, it } from "vitest";
import { destinationFor, resolveDestination, type DestinationContext } from "./destinations";
import { HELP_TOPICS, helpTopicFor, helpTopics } from "./helpTopics";

const WEB: DestinationContext = { platform: "web", signedIn: true, capabilities: [] };

describe("offline help articles", () => {
  it("gives every article real text and a destination the caller can reach", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.body.length, topic.id).toBeGreaterThan(0);
      expect(topic.body.every((paragraph) => paragraph.trim().length > 0), topic.id).toBe(true);
      expect(topic.summary.length, topic.id).toBeGreaterThan(0);
      if (topic.destinationId) {
        expect(destinationFor(topic.destinationId), topic.id).not.toBeNull();
        // A topic follows its destination's platform: `local-search` describes
        // on-device tools, which only the Android build has.
        const caller = topic.platforms.includes("web") ? WEB : { ...WEB, platform: "android" as const };
        expect(resolveDestination(topic.destinationId, caller), topic.id).toEqual(expect.objectContaining({ kind: "available" }));
      }
    }
  });

  it("carries no article for an unknown destination id", () => {
    const offered = helpTopics(WEB);
    expect(offered.length).toBeGreaterThan(0);
    for (const topic of offered) {
      if (topic.destinationId) expect(destinationFor(topic.destinationId)).not.toBeNull();
    }
    expect(helpTopicFor("no-such-article")).toBeNull();
  });

  it("keeps the articles that state a real limitation", () => {
    // Backup is best-effort; a downloaded model is not a working helper; a place
    // name narrows loaded reports; deletions leave safety records.
    const text = (id: string) => helpTopicFor(id)!.body.join(" ").toLowerCase();
    expect(text("backup")).toContain("best-effort");
    expect(text("backup")).toContain("google drive");
    expect(text("local-search")).toContain("ordinary text search");
    // Word search is a server query; only the place scope is device-side.
    expect(text("search-filter")).toContain("on norfold's servers");
    expect(text("search-filter")).toContain("already loaded here");
    expect(text("delete-account")).toContain("safety records remain");
  });

  it("names the optional cloud assistant as a provider chat, not app support", () => {
    const topic = helpTopicFor("ask-provider")!;
    expect(topic.title.toLowerCase()).toContain("provider");
    expect(topic.body.join(" ").toLowerCase()).toContain("cloud");
    expect(topic.body.join(" ").toLowerCase()).toContain("not app support");
  });

  it("uses reactions rather than likes on the notifications article", () => {
    const topic = helpTopicFor("notifications")!;
    expect(topic.summary).toBe("Reactions, comments, and mentions land in your inbox.");
    expect(topic.body.join(" ")).not.toMatch(/likes/i);
  });
});
