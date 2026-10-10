// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReactionArt } from "./ReactionArt";
import { ReactionPreviewStack, topReactionKinds } from "./ReactionPreviewStack";

afterEach(cleanup);

describe("ReactionArt", () => {
  it("renders filled SVG artwork for every kind (no emoji-font glyph)", () => {
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      expect(art.tagName.toLowerCase()).toBe("svg");
      expect(art.getAttribute("fill")).toBe("currentColor");
      // Artwork only — no text, no emoji characters.
      expect(art.textContent?.trim()).toBe("");
      cleanup();
    }
  });

  it("tints with the functional kind var, never the accent", () => {
    render(<ReactionArt kind="WOW" />);
    const art = screen.getByTestId("reaction-art-WOW");
    expect((art as unknown as HTMLElement).style.color).toBe("var(--fb-reaction-wow)");
  });
});

describe("topReactionKinds", () => {
  it("returns the top kinds best-first with canonical tie-break", () => {
    expect(topReactionKinds({ LOVE: 1, WOW: 4, HELPFUL: 2 })).toEqual(["WOW", "HELPFUL", "LOVE"]);
    expect(topReactionKinds({ WOW: 2, LOVE: 2 })).toEqual(["LOVE", "WOW"]);
    expect(topReactionKinds({})).toEqual([]);
  });

  it("caps at three by default", () => {
    expect(topReactionKinds({ LOVE: 4, HELPFUL: 3, SUPPORT: 2, WOW: 1 })).toEqual([
      "LOVE",
      "HELPFUL",
      "SUPPORT",
    ]);
  });
});

describe("ReactionPreviewStack", () => {
  it("renders nothing when there are no reactions", () => {
    render(<ReactionPreviewStack counts={{}} />);
    expect(screen.queryByTestId("reaction-preview-stack")).toBeNull();
  });

  it("stacks the top-3 filled arts with no counts inside", () => {
    render(<ReactionPreviewStack counts={{ LOVE: 5, WOW: 3, HELPFUL: 2, SUPPORT: 1 }} />);
    expect(screen.getByTestId("reaction-preview-stack")).toBeTruthy();
    expect(screen.getByTestId("reaction-preview-LOVE")).toBeTruthy();
    expect(screen.getByTestId("reaction-preview-WOW")).toBeTruthy();
    expect(screen.getByTestId("reaction-preview-HELPFUL")).toBeTruthy();
    expect(screen.queryByTestId("reaction-preview-SUPPORT")).toBeNull();
    expect(screen.getByTestId("reaction-preview-stack").textContent?.trim()).toBe("");
  });
});
