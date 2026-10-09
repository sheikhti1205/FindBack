// @vitest-environment jsdom
// W5 ReactionTray kind colors: each option carries its functional mapping and
// renders the kind color on icon + count — never the user accent.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactionTray } from "./ReactionTray";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";

afterEach(cleanup);

const KIND_VAR = {
  LOVE: "--fb-reaction-love",
  HELPFUL: "--fb-reaction-helpful",
  SUPPORT: "--fb-reaction-support",
  WOW: "--fb-reaction-wow",
} as const;

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

  it("paints icon + count with the kind var and never the accent", () => {
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
      const svg = option.querySelector("svg");
      expect(svg?.style.color).toBe(`var(${KIND_VAR[kind]})`);
      const count = option.querySelector(".tabular-nums") as HTMLElement | null;
      expect(count?.style.color).toBe(`var(${KIND_VAR[kind]})`);
      // No accent/primary binding anywhere on the option.
      expect(option.className).not.toMatch(/accent/);
      expect(`${svg?.style.color}${count?.style.color}`).not.toMatch(/--fb-primary|--fb-accent/);
    }
  });
});
