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

  it("offers the four canonical kinds as icon-only pill choices with the active one marked", () => {
    render(<OpenTray myReaction="HELPFUL" />);
    const tray = screen.getByTestId("reaction-tray");
    expect(tray.getAttribute("role")).toBe("menu");
    // Floating pill, not a rectangular labeled card.
    expect(tray.className).toMatch(/rounded-full/);
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      const option = screen.getByTestId(`reaction-option-${kind}`);
      expect(option).toBeTruthy();
      // Screen-reader name retained; no visible label or count inside.
      expect(option.getAttribute("aria-label")).toMatch(/love|helpful|support|wow/i);
      expect(option.textContent?.trim()).toBe("");
      // Large filled SVG artwork, never an emoji-font glyph.
      const art = option.querySelector(`[data-testid="reaction-art-${kind}"]`);
      expect(art).toBeTruthy();
      expect(art?.tagName.toLowerCase()).toBe("svg");
    }
    expect(screen.getByTestId("reaction-option-HELPFUL").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("reaction-option-LOVE").getAttribute("aria-checked")).toBe("false");
    // Legacy LIKE reads as the canonical Love.
    cleanup();
    render(<OpenTray myReaction="LIKE" />);
    expect(screen.getByTestId("reaction-option-LOVE").getAttribute("aria-checked")).toBe("true");
  });

  it("lifts the hovered choice (slide-to-select visual)", () => {
    render(<OpenTray />);
    const love = screen.getByTestId("reaction-option-LOVE");
    fireEvent.pointerEnter(love);
    expect(love.getAttribute("data-hovered")).toBe("true");
    expect(love.style.transform).toContain("scale(1.3)");
    const helpful = screen.getByTestId("reaction-option-HELPFUL");
    expect(helpful.getAttribute("data-hovered")).toBe("false");
  });

  it("selects the hovered choice on drag-release from the trigger (no second tap)", () => {
    const onSelect = vi.fn();
    render(<OpenTray onSelect={onSelect} />);
    const love = screen.getByTestId("reaction-option-LOVE");
    // Finger slid from the trigger onto LOVE while held: hover tracks it.
    fireEvent.pointerEnter(love);
    // Release: pointerup bubbles from the tray (down was outside, so this is
    // the drag path — click must not double-fire).
    fireEvent.pointerUp(screen.getByTestId("reaction-tray"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("LOVE");
    fireEvent.click(love);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("selects a kind through a direct tap (click path)", () => {
    const onSelect = vi.fn();
    render(<OpenTray onSelect={onSelect} />);
    const option = screen.getByTestId("reaction-option-SUPPORT");
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
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

  it("subscribes to scroll in the capture phase so inner-container flings cancel the tray", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    try {
      render(<OpenTray />);
      const scrollCalls = addSpy.mock.calls.filter(([type]) => type === "scroll");
      expect(scrollCalls.length).toBeGreaterThan(0);
      expect(scrollCalls.some(([, , options]) => (options as AddEventListenerOptions)?.capture === true)).toBe(
        true,
      );
    } finally {
      addSpy.mockRestore();
    }
    cleanup();
  });

  it("closes on inner-container scroll (capture) and on visualViewport resize/scroll", () => {
    const onClose = vi.fn();
    const listeners = new Map<string, Set<EventListener>>();
    const viewport = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      }),
    };
    const previous = window.visualViewport;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      render(<OpenTray onClose={onClose} />);
      // Inner Shell scroller flings: a non-bubbling scroll dispatched on a
      // descendant still reaches the window capture-phase listener.
      const scroller = document.createElement("div");
      document.body.appendChild(scroller);
      try {
        scroller.dispatchEvent(new Event("scroll", { bubbles: false, cancelable: true }));
      } finally {
        scroller.remove();
      }
      expect(onClose).toHaveBeenCalled();
      onClose.mockClear();
      // Keyboard/zoom-driven viewport moves close the tray too.
      for (const type of ["scroll", "resize"]) {
        for (const listener of listeners.get(type) ?? []) {
          listener(new Event(type));
        }
      }
      expect(onClose).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });
});
