// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "framer-motion";
import { RatingStars } from "./RatingStars";

afterEach(cleanup);

/** Scale written by Motion, or 1 when the element is at rest. */
function scaleOf(el: HTMLElement): number {
  const match = el.style.transform.match(/scale\((-?[\d.]+)\)/);
  return match ? Number.parseFloat(match[1] ?? "1") : 1;
}

function atRest(el: HTMLElement): boolean {
  return el.style.transform === "" || el.style.transform === "none";
}

function starParts(name: RegExp) {
  const radio = screen.getByRole("radio", { name });
  return {
    radio,
    pop: radio.querySelector("[data-star-pop]") as HTMLElement,
    fill: radio.querySelector("[data-star-fill]") as HTMLElement,
  };
}

describe("RatingStars", () => {
  it("moves focus on arrows without rating", () => {
    const onRate = vi.fn();
    render(<><span id="lbl">Your rating</span><RatingStars value={null} onRate={onRate} labelId="lbl" /></>);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    // Exactly one tab stop for the group.
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios[0]!.getAttribute("tabindex")).toBe("0");

    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[0]);
    // Focus-only navigation: zero rating mutations.
    expect(onRate).not.toHaveBeenCalled();
  });

  it("keeps the selected star as the tab stop and announces checked state", () => {
    const onRate = vi.fn();
    render(<RatingStars value={4} onRate={onRate} ariaLabel="Rating" />);
    const radios = screen.getAllByRole("radio");
    expect(radios[3]!.getAttribute("tabindex")).toBe("0");
    expect(radios[3]!.getAttribute("aria-checked")).toBe("true");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("moves focus on Home and End without rating", () => {
    const onRate = vi.fn();
    render(<RatingStars value={3} onRate={onRate} ariaLabel="Rating" />);
    const radios = screen.getAllByRole("radio");
    radios[2]!.focus();
    fireEvent.keyDown(radios[2]!, { key: "End" });
    expect(document.activeElement).toBe(radios[4]);
    radios[4]!.focus();
    fireEvent.keyDown(radios[4]!, { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    expect(onRate).not.toHaveBeenCalled();
  });

  it("rates on click", () => {
    const onRate = vi.fn();
    render(<RatingStars value={null} onRate={onRate} ariaLabel="Rating" />);
    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));
    expect(onRate).toHaveBeenCalledWith(3);
  });

  it("pops the tapped star immediately without waiting for the value", async () => {
    const onRate = vi.fn();
    // The parent never updates the value: the acknowledgement must still
    // play on tap (optimistic), then settle quietly (restrained rollback).
    render(<RatingStars value={null} onRate={onRate} ariaLabel="Rating" />);
    const { pop, fill, radio } = starParts(/3 stars/);
    expect(pop).toBeTruthy();

    fireEvent.click(radio);
    expect(onRate).toHaveBeenCalledWith(3);
    // Brief scale pop, then back to rest — never stuck mid-flight.
    const peak = await waitFor(() => {
      const s = scaleOf(pop);
      if (s <= 1) throw new Error("pop has not started");
      return s;
    });
    expect(peak).toBeGreaterThan(1);
    await waitFor(() => expect(atRest(pop)).toBe(true));
    // No value arrived, so no fill sticks and nothing stays checked.
    expect(fill.style.opacity).toBe("0");
    expect(radio.getAttribute("aria-checked")).toBe("false");
  });

  it("crossfades the fill when the value changes", async () => {
    const { rerender } = render(<RatingStars value={null} onRate={vi.fn()} ariaLabel="Rating" />);
    const before = starParts(/3 stars/).fill;
    expect(before).toBeTruthy();
    expect(before.style.opacity).toBe("0");

    rerender(<RatingStars value={3} onRate={vi.fn()} ariaLabel="Rating" />);
    const after = starParts(/3 stars/).fill;
    // Same node — no remount blink.
    expect(after).toBe(before);
    await waitFor(() => expect(after.style.opacity).toBe("1"));
    // Untouched stars stay empty; checked state follows the value.
    expect(starParts(/5 stars/).fill.style.opacity).toBe("0");
    expect(screen.getByRole("radio", { name: "3 stars" }).getAttribute("aria-checked")).toBe("true");
  });

  it("releases the fill quietly when the value rolls back", async () => {
    const { rerender } = render(<RatingStars value={3} onRate={vi.fn()} ariaLabel="Rating" />);
    // initial={false}: the confirmed fill renders at its target, never mid-flight.
    expect(starParts(/3 stars/).fill.style.opacity).toBe("1");

    rerender(<RatingStars value={1} onRate={vi.fn()} ariaLabel="Rating" />);
    const { fill, pop } = starParts(/3 stars/);
    // No pop on unfill — rollback is a quiet release, not a bounce.
    expect(atRest(pop)).toBe(true);
    await waitFor(() => expect(fill.style.opacity).toBe("0"));
    expect(screen.getByRole("radio", { name: "3 stars" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "1 star" }).getAttribute("aria-checked")).toBe("true");
  });

  it("skips the pop travel under reduced motion", async () => {
    render(
      <MotionConfig reducedMotion="always">
        <RatingStars value={null} onRate={vi.fn()} ariaLabel="Rating" />
      </MotionConfig>,
    );
    const { pop } = starParts(/2 stars/);
    fireEvent.click(screen.getByRole("radio", { name: "2 stars" }));
    // Past the point a full-motion pop would be mid-flight: still at rest.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(atRest(pop)).toBe(true);
  });
});
