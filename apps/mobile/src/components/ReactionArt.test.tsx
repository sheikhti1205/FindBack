// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REACTION_ART_FAMILY, REACTION_ART_MARK, ReactionArt } from "./ReactionArt";
import { ReactionArtFixture } from "./ReactionArt.fixture";
import {
  REACTION_TRAY_REDUCED_MOTION_CSS,
  ReactionTray,
  ReactionTrayChooseTrigger,
} from "./ReactionTray";
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

describe("ReactionArt FBX-018 original family", () => {
  const KINDS = ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const;

  it("carries a per-kind art marker in one consistent family (red on generic art)", () => {
    for (const kind of KINDS) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      expect(art.getAttribute("data-family")).toBe(REACTION_ART_FAMILY);
      expect(art.getAttribute("data-art")).toBe(REACTION_ART_MARK[kind]);
      cleanup();
    }
    expect(new Set(Object.values(REACTION_ART_MARK)).size).toBe(4);
  });

  it("is composed original multi-shape art, not a single generic path", () => {
    for (const kind of KINDS) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      // Old monochrome art was exactly one <path>; the new family layers
      // shapes (base + highlight + accent).
      expect(art.querySelectorAll("path,circle,ellipse,rect").length).toBeGreaterThan(1);
      cleanup();
    }
  });

  it("is colorful (fixed decorative tones over the functional tint), never monochrome", () => {
    for (const kind of KINDS) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      const tones = Array.from(art.querySelectorAll("[fill],[stroke]")).filter((el) => {
        const v = el.getAttribute("fill") ?? el.getAttribute("stroke") ?? "";
        return v !== "" && v !== "currentColor" && v !== "none";
      });
      expect(tones.length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("renders no emoji glyph or text at any production size", () => {
    const sizes = [15, 16, 18, 20, 30];
    for (const kind of KINDS) {
      for (const size of sizes) {
        render(<ReactionArt kind={kind} size={size} />);
        const art = screen.getByTestId(`reaction-art-${kind}`);
        expect(art.tagName.toLowerCase()).toBe("svg");
        expect(art.getAttribute("viewBox")).toBe("0 0 24 24");
        expect(art.getAttribute("width")).toBe(String(size));
        expect(art.textContent?.trim()).toBe("");
        expect(art.innerHTML).not.toMatch(
          /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u,
        );
        expect(art.querySelector("text")).toBeNull();
        cleanup();
      }
    }
  });
});

describe("ReactionTray FBX-018 chevron-free + compact alternate", () => {
  function OpenTray() {
    return (
      <div>
        <button type="button" id="tray-trigger">
          open
        </button>
        <ReactionTray
          open
          myReaction={null}
          counts={{}}
          total={0}
          onSelect={() => {}}
          onClose={() => {}}
          triggerId="tray-trigger"
        />
      </div>
    );
  }

  it("has no chevron anywhere in the tray or its accessible alternate", () => {
    const onToggle = vi.fn();
    render(
      <div>
        <OpenTray />
        <ReactionTrayChooseTrigger id="choose-compact" expanded={false} onToggle={onToggle} />
      </div>,
    );
    const tray = screen.getByTestId("reaction-tray");
    // Every svg inside the tray is reaction art — no chevron/utility glyph.
    for (const svg of Array.from(tray.querySelectorAll("svg"))) {
      expect(svg.getAttribute("data-testid")).toMatch(/^reaction-art-/);
    }
    expect(tray.innerHTML).not.toMatch(/chevron/i);
    const alternate = screen.getByTestId("reaction-choose-compact");
    expect(alternate.innerHTML).not.toMatch(/chevron/i);
    expect(alternate.querySelector("svg")?.getAttribute("data-testid")).toBe(
      "reaction-choose-compact-glyph",
    );
  });

  it("offers the compact alternate trigger with the full keyboard path", () => {
    const onToggle = vi.fn();
    render(<ReactionTrayChooseTrigger id="choose-compact" expanded={false} onToggle={onToggle} />);
    const trigger = screen.getByTestId("reaction-choose-compact");
    expect(trigger.tagName.toLowerCase()).toBe("button");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toMatch(/choose reaction/i);
    expect(trigger.className).toMatch(/min-h-\[44px\]/);
    expect(trigger.className).toMatch(/min-w-\[44px\]/);
    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ReactionTrayChooseTrigger id="choose-compact" expanded onToggle={() => {}} />);
    expect(screen.getByTestId("reaction-choose-compact").getAttribute("aria-expanded")).toBe("true");
  });

  it("ships a prefers-reduced-motion fallback with the tray", () => {
    expect(REACTION_TRAY_REDUCED_MOTION_CSS).toMatch(/prefers-reduced-motion/);
    render(<OpenTray />);
    const motion = screen.getByTestId("reaction-tray-motion");
    expect(motion.tagName.toLowerCase()).toBe("style");
    expect(motion.textContent ?? "").toMatch(/prefers-reduced-motion/);
    // Existing Tailwind fallback stays on every option.
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(screen.getByTestId(`reaction-option-${kind}`).className).toMatch(/motion-reduce/);
    }
  });
});

describe("ReactionArtFixture", () => {
  it("renders all kinds × sizes × light/dark/true-black with the 320dp note", () => {
    render(<ReactionArtFixture />);
    expect(screen.getByTestId("reaction-art-fixture")).toBeTruthy();
    expect(screen.getByTestId("reaction-fixture-note").textContent ?? "").toMatch(/320dp/);
    for (const theme of ["light", "dark", "true-black"] as const) {
      expect(screen.getByTestId(`reaction-fixture-theme-${theme}`)).toBeTruthy();
      for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
        expect(screen.getByTestId(`reaction-fixture-row-${theme}-${kind}`)).toBeTruthy();
        for (const size of [15, 16, 18, 20, 30]) {
          expect(screen.getByTestId(`reaction-fixture-cell-${theme}-${kind}-${size}`)).toBeTruthy();
        }
      }
      const band = screen.getByTestId(`reaction-fixture-320-${theme}`);
      expect((band as HTMLElement).style.maxWidth).toBe("320px");
    }
  });
});
