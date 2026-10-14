// @vitest-environment jsdom
// W5 ReactionTray kind colors: each option carries its functional mapping and
// keeps the kind's active affordance — never the user accent. The tray is
// icon-only: no labels or counts are rendered inside it. Reactions render as
// canonical system emoji (no custom art); the functional mapping survives on
// data attributes + the active indicator dot.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactionTray } from "./ReactionTray";
import { REACTION_EMOJI } from "../services/reactions";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";

afterEach(cleanup);

describe("ReactionTray functional kind colors (W5)", () => {
  it("maps every kind to its functional color id", () => {
    render(
      <div>
        <button type="button" id="tray-trigger">open</button>
        <ReactionTray
          open
          myReaction={null}
          counts={{ LOVE: 3, HELPFUL: 1, SUPPORT: 2, WOW: 1 }}
          total={7}
          onSelect={() => {}}
          onClose={() => {}}
          triggerId="tray-trigger"
        />
      </div>,
    );
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      const option = screen.getByTestId(`reaction-option-${kind}`);
      expect(option.getAttribute("data-functional-color")).toBe(REACTION_KIND_FUNCTIONAL[kind]);
    }
  });

  it("renders canonical system emoji with the active dot in the kind color (no counts inside)", () => {
    const onSelect = vi.fn();
    render(
      <div>
        <button type="button" id="tray-trigger">open</button>
        <ReactionTray
          open
          myReaction="LOVE"
          counts={{ LOVE: 3 }}
          total={3}
          onSelect={onSelect}
          onClose={() => {}}
          triggerId="tray-trigger"
        />
      </div>,
    );
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      const option = screen.getByTestId(`reaction-option-${kind}`);
      // Canonical system emoji shared with every other surface.
      expect(option.textContent).toContain(REACTION_EMOJI[kind]);
      expect(option.querySelector("svg,img")).toBeNull();
      // Icon-only tray: no visible label or count text.
      expect(option.querySelector(".tabular-nums")).toBeNull();
      // No accent/primary binding anywhere on the option.
      expect(option.className).not.toMatch(/accent/);
      expect(option.innerHTML).not.toMatch(/--fb-primary|--fb-accent/);
    }
    // Active kind keeps its dot indicator in the kind color.
    const dot = screen.getByTestId("reaction-active-LOVE");
    expect(dot.style.backgroundColor).toBe("var(--fb-reaction-love)");
    expect(screen.queryByTestId("reaction-active-HELPFUL")).toBeNull();
  });
});
