// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ReactionTray, topReactionKind } from "./ReactionTray";
import type { ReactionKind } from "@findback/shared";

function OpenTray({
  myReaction = null,
  onSelect = () => {},
  onClose = () => {},
}: {
  myReaction?: ReactionKind | null;
  onSelect?: (kind: ReactionKind) => void;
  onClose?: () => void;
}) {
  return (
    <div>
      <button type="button" id="tray-trigger">
        open
      </button>
      <ReactionTray
        open
        myReaction={myReaction}
        counts={{ LOVE: 3, WOW: 1 }}
        total={4}
        onSelect={onSelect}
        onClose={onClose}
        triggerId="tray-trigger"
      />
    </div>
  );
}

afterEach(cleanup);

describe("topReactionKind", () => {
  it("picks the kind with the highest count", () => {
    expect(topReactionKind({ LOVE: 1, WOW: 4, HELPFUL: 2 })).toBe("WOW");
  });

  it("returns null for an empty count map", () => {
    expect(topReactionKind({})).toBeNull();
  });

  it("breaks ties in canonical tray order (LOVE first)", () => {
    expect(topReactionKind({ WOW: 2, LOVE: 2 })).toBe("LOVE");
  });
});

describe("ReactionTray", () => {
  it("renders nothing while closed (red: component missing)", () => {
    render(
      <ReactionTray
        open={false}
        myReaction={null}
        counts={{}}
        total={0}
        onSelect={() => {}}
        onClose={() => {}}
        triggerId="tray-trigger"
      />,
    );
    expect(screen.queryByTestId("reaction-tray")).toBeNull();
  });

  it("offers the four canonical kinds with counts and marks the active one", () => {
    render(<OpenTray myReaction="HELPFUL" />);
    const tray = screen.getByTestId("reaction-tray");
    expect(tray.getAttribute("role")).toBe("menu");
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(screen.getByTestId(`reaction-option-${kind}`)).toBeTruthy();
    }
    expect(screen.getByTestId("reaction-option-HELPFUL").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("reaction-option-LOVE").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("reaction-option-LOVE").textContent).toContain("3");
    // Legacy LIKE reads as the canonical Love.
    cleanup();
    render(<OpenTray myReaction="LIKE" />);
    expect(screen.getByTestId("reaction-option-LOVE").getAttribute("aria-checked")).toBe("true");
  });

  it("selects a kind through the real service value (no fake mapping)", () => {
    const onSelect = vi.fn();
    render(<OpenTray onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("reaction-option-SUPPORT"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("SUPPORT");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const onClose = vi.fn();
    function EscProbe() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" id="tray-trigger">
            open
          </button>
          {open && (
            <ReactionTray
              open
              myReaction={null}
              counts={{}}
              total={0}
              onSelect={() => {}}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
              triggerId="tray-trigger"
            />
          )}
        </div>
      );
    }
    render(<EscProbe />);
    fireEvent.keyDown(screen.getByTestId("reaction-tray"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.getElementById("tray-trigger")).toBe(document.activeElement);
  });

  it("moves with arrow keys and activates with Enter (keyboard path needs no long-press)", () => {
    const onSelect = vi.fn();
    render(<OpenTray onSelect={onSelect} />);
    const tray = screen.getByTestId("reaction-tray");
    const love = screen.getByTestId("reaction-option-LOVE");
    love.focus();
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("reaction-option-HELPFUL");
    fireEvent.keyDown(tray, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("HELPFUL");
  });

  it("buzzes once on open where vibration is supported, and stays silent otherwise", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    try {
      render(<OpenTray />);
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith(10);
    } finally {
      // jsdom has no vibrate by default; restore the absent state.
      Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });
    }
    cleanup();
    render(<OpenTray />);
    expect(screen.getByTestId("reaction-tray")).toBeTruthy();
  });

  it("keeps every option on a >=44px touch target", () => {
    render(<OpenTray />);
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      const option = screen.getByTestId(`reaction-option-${kind}`);
      expect(option.className).toMatch(/min-h-\[44px\]/);
      expect(option.className).toMatch(/min-w-\[44px\]/);
    }
  });
});
