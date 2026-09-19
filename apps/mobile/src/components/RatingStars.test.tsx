// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatingStars } from "./RatingStars";

afterEach(cleanup);

describe("RatingStars", () => {
  it("moves focus on arrows without rating (WP12/#35)", () => {
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
});
