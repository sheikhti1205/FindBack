import { describe, expect, it } from "vitest";
import {
  classifyAssistantIntent,
  ctaForRoute,
  getAssistantDefault,
  resolveAssistantIntent,
  routeForIntent,
} from "./intentRouter";

describe("intentRouter (Lane B): classify → route → validated CTA", () => {
  it("classifies deterministically: lost / found / search / app-question / general", () => {
    expect(classifyAssistantIntent("I lost my keys")).toBe("REPORT_LOST");
    expect(classifyAssistantIntent("I found a wallet")).toBe("REPORT_FOUND");
    expect(classifyAssistantIntent("search for red backpack")).toBe("SEARCH");
    expect(classifyAssistantIntent("how do I report a lost item?")).toBe("APP_QUESTION");
    expect(classifyAssistantIntent("hello")).toBe("OPEN_QUESTION");
    expect(classifyAssistantIntent("")).toBe("UNKNOWN");
    expect(classifyAssistantIntent("   ")).toBe("UNKNOWN");
  });

  it("routes each intent to its allowed destination", () => {
    expect(routeForIntent("REPORT_LOST")).toBe("OPEN_REPORT_LOST");
    expect(routeForIntent("REPORT_FOUND")).toBe("OPEN_REPORT_FOUND");
    expect(routeForIntent("SEARCH")).toBe("OPEN_SEARCH");
    expect(routeForIntent("APP_QUESTION")).toBe("OPEN_HELP");
    expect(routeForIntent("UNKNOWN")).toBe("ASK_USER");
    expect(routeForIntent("OPEN_QUESTION")).toBe("ASK_USER");
  });

  it("maps routes to validated in-app CTA targets (never silent navigation)", () => {
    expect(ctaForRoute("OPEN_SEARCH")).toEqual({ id: "OPEN_SEARCH", label: "Open search", target: "/search" });
    expect(ctaForRoute("OPEN_REPORT_LOST")).toMatchObject({ target: "/report" });
    expect(ctaForRoute("OPEN_REPORT_FOUND")).toMatchObject({ target: "/report" });
    expect(ctaForRoute("OPEN_HELP")).toMatchObject({ target: "/help" });
    expect(ctaForRoute("ASK_USER")).toBeNull();
  });

  it("keeps the OPEN_MAP location precondition: no location, no CTA", () => {
    expect(ctaForRoute("OPEN_MAP")).toBeNull();
    expect(ctaForRoute("OPEN_MAP", {})).toBeNull();
    expect(ctaForRoute("OPEN_MAP", { hasLocation: false })).toBeNull();
    expect(ctaForRoute("OPEN_MAP", { hasLocation: true })).toMatchObject({ target: "/search" });
  });

  it("resolves the full chain and clarifies instead of navigating when ambiguous", () => {
    const lost = resolveAssistantIntent("I lost my keys near the park");
    expect(lost.intent).toBe("REPORT_LOST");
    expect(lost.route).toBe("OPEN_REPORT_LOST");
    expect(lost.cta?.target).toBe("/report");

    const vague = resolveAssistantIntent("I lost something.");
    expect(vague.cta).toBeNull();
    expect(vague.clarification).toMatch(/lost report|found report|search/i);
  });

  it("reads the Lane A persisted default fallback-safe (raw choice; null without account or stored choice)", () => {
    expect(getAssistantDefault()).toBeNull();
    expect(getAssistantDefault("")).toBeNull();
    // No stored choice in this environment → null (Automatic). The free
    // route is resolved at send time, never by this seam: seeding Help with
    // a resolved id would fake a user choice and hide Select buttons.
    expect(getAssistantDefault("acct-a")).toBeNull();
  });
});
