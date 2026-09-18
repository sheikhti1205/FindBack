// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatingStars } from "./RatingStars";

afterEach(cleanup);

describe("RatingStars", () => {
  it("exposes one tab stop and arrow-key navigation (WP12)", () => {
    const onRate = vi.fn();
    render(<><span id="lbl">Your rating</span><RatingStars value={null} onRate={onRate} labelId="lbl" /></>);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    // Exactly one tab stop for the group.
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios[0]!.getAttribute("tabindex")).toBe("0");

    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(onRate).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(radios[1]);
  });

  it("keeps the selected star as the tab stop and announces checked state", () => {
    const onRate = vi.fn();
    render(<RatingStars value={4} onRate={onRate} ariaLabel="Rating" />);
    const radios = screen.getAllByRole("radio");
    expect(radios[3]!.getAttribute("tabindex")).toBe("0");
    expect(radios[3]!.getAttribute("aria-checked")).toBe("true");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("supports Home and End keys", () => {
    const onRate = vi.fn();
    render(<RatingStars value={3} onRate={onRate} ariaLabel="Rating" />);
    const radios = screen.getAllByRole("radio");
    radios[2]!.focus();
    fireEvent.keyDown(radios[2]!, { key: "End" });
    expect(onRate).toHaveBeenLastCalledWith(5);
    radios[4]!.focus();
    fireEvent.keyDown(radios[4]!, { key: "Home" });
    expect(onRate).toHaveBeenLastCalledWith(1);
  });

  it("rates on click", () => {
    const onRate = vi.fn();
    render(<RatingStars value={null} onRate={onRate} ariaLabel="Rating" />);
    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));
    expect(onRate).toHaveBeenCalledWith(3);
  });
});
