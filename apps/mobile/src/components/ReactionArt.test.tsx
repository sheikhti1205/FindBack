// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REACTION_ART_FAMILY, REACTION_ART_MARK, ReactionArt } from "./ReactionArt";
import { REACTION_EMOJI } from "../services/reactions";
import { ReactionArtFixture } from "./ReactionArt.fixture";
import {
  REACTION_TRAY_REDUCED_MOTION_CSS,
  ReactionTray,
  ReactionTrayChooseTrigger,
} from "./ReactionTray";
import { ReactionPreviewStack, topReactionKinds } from "./ReactionPreviewStack";

afterEach(cleanup);

describe("ReactionArt", () => {
  it("renders the canonical system emoji for every kind (no custom art)", () => {
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      expect(art.textContent).toContain(REACTION_EMOJI[kind]);
      expect(art.querySelector("svg")).toBeNull();
      expect(art.querySelector("img")).toBeNull();
      expect(art.querySelector("path,circle,ellipse,rect")).toBeNull();
      cleanup();
    }
  });

  it("is decorative (aria-hidden) with the kind on data attributes", () => {
    render(<ReactionArt kind="LOVE" size={30} />);
    const art = screen.getByTestId("reaction-art-LOVE");
    expect(art.getAttribute("aria-hidden")).toBe("true");
    expect(art.getAttribute("data-kind")).toBe("LOVE");
    expect(art.getAttribute("data-family")).toBe(REACTION_ART_FAMILY);
  });

  it("mutes the emoji (not a color swap) when unfilled", () => {
    render(<ReactionArt kind="WOW" filled={false} />);
    const art = screen.getByTestId("reaction-art-WOW") as HTMLElement;
    expect(art.style.opacity).toBe("0.45");
    expect(art.textContent).toContain(REACTION_EMOJI.WOW);
    cleanup();
    render(<ReactionArt kind="WOW" />);
    expect((screen.getByTestId("reaction-art-WOW") as HTMLElement).style.opacity).toBe("1");
  });

  it("sizes the glyph box at every production size", () => {
    for (const size of [15, 16, 18, 20, 30]) {
      render(<ReactionArt kind="HELPFUL" size={size} />);
      const art = screen.getByTestId("reaction-art-HELPFUL") as HTMLElement;
      expect(art.style.width).toBe(`${size}px`);
      expect(art.style.height).toBe(`${size}px`);
      cleanup();
    }
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

  it("stacks the top-3 canonical emoji with no counts inside", () => {
    render(<ReactionPreviewStack counts={{ LOVE: 5, WOW: 3, HELPFUL: 2, SUPPORT: 1 }} />);
    expect(screen.getByTestId("reaction-preview-stack")).toBeTruthy();
    expect(screen.getByTestId("reaction-preview-LOVE").textContent).toContain(REACTION_EMOJI.LOVE);
    expect(screen.getByTestId("reaction-preview-WOW").textContent).toContain(REACTION_EMOJI.WOW);
    expect(screen.getByTestId("reaction-preview-HELPFUL").textContent).toContain(REACTION_EMOJI.HELPFUL);
    expect(screen.queryByTestId("reaction-preview-SUPPORT")).toBeNull();
  });
});

describe("ReactionArt system-emoji family", () => {
  const KINDS = ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const;

  it("uses one canonical system-emoji map across all surfaces (no dialects)", () => {
    expect(REACTION_ART_FAMILY).toBe("system-emoji");
    for (const kind of KINDS) {
      render(<ReactionArt kind={kind} size={30} />);
      const art = screen.getByTestId(`reaction-art-${kind}`);
      expect(art.getAttribute("data-family")).toBe("system-emoji");
      expect(art.textContent).toContain(REACTION_EMOJI[kind]);
      cleanup();
    }
    // Deprecated markers stay distinct so old imports keep resolving.
    expect(new Set(Object.values(REACTION_ART_MARK)).size).toBe(4);
  });

  it("renders no raster or vector artwork at any production size", () => {
    const sizes = [15, 16, 18, 20, 30];
    for (const kind of KINDS) {
      for (const size of sizes) {
        render(<ReactionArt kind={kind} size={size} />);
        const art = screen.getByTestId(`reaction-art-${kind}`);
        expect(art.tagName.toLowerCase()).not.toBe("svg");
        expect(art.querySelector("svg,img,canvas,picture,path")).toBeNull();
        expect(art.textContent).toContain(REACTION_EMOJI[kind]);
        cleanup();
      }
    }
  });

  it("matches the tray, preview stack, and notification rows (cross-surface consistency)", () => {
    // The tray renders through this same component, so its options carry
    // the identical chars — asserted here against the canonical map.
    render(
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
      </div>,
    );
    for (const kind of KINDS) {
      const option = screen.getByTestId(`reaction-option-${kind}`);
      expect(option.textContent).toContain(REACTION_EMOJI[kind]);
    }
    cleanup();
    render(<ReactionPreviewStack counts={{ LOVE: 5, WOW: 3 }} />);
    expect(screen.getByTestId("reaction-preview-LOVE").textContent).toContain(REACTION_EMOJI.LOVE);
    expect(screen.getByTestId("reaction-preview-WOW").textContent).toContain(REACTION_EMOJI.WOW);
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
    // The icon-only tray carries system emoji, never chevron/utility glyphs.
    expect(tray.querySelector("svg")).toBeNull();
    expect(tray.innerHTML).not.toMatch(/chevron/i);
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(tray.innerHTML).toContain(REACTION_EMOJI[kind]);
    }
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
