// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

afterEach(cleanup);

const OPTIONS = [
  { value: "ALL", label: "All" },
  { value: "LOST", label: "Lost" },
  { value: "FOUND", label: "Found" },
] as const;

describe("Segmented motion pass", () => {
  it("keeps the radio API (roving tab stop, aria-checked, arrows)", () => {
    const onChange = vi.fn();
    render(<Segmented value="ALL" onChange={onChange} options={[...OPTIONS]} ariaLabel="Post type" />);
    expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "All" }).getAttribute("tabIndex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Lost" }).getAttribute("tabIndex")).toBe("-1");

    fireEvent.click(screen.getByRole("radio", { name: "Lost" }));
    expect(onChange).toHaveBeenCalledWith("LOST");
  });

  it("slides one shared selection background to the selected option", () => {
    const { rerender } = render(
      <Segmented value="ALL" onChange={() => {}} options={[...OPTIONS]} ariaLabel="Post type" />,
    );
    const group = screen.getByRole("radiogroup");
    // Exactly one sliding background, hidden from assistive tech.
    expect(group.querySelectorAll('[data-testid="segmented-selection"]')).toHaveLength(1);
    expect(
      group.querySelector('[data-testid="segmented-selection"]')?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.getByRole("radio", { name: "All" }).contains(
      group.querySelector('[data-testid="segmented-selection"]')!,
    )).toBe(true);

    rerender(<Segmented value="FOUND" onChange={() => {}} options={[...OPTIONS]} ariaLabel="Post type" />);
    expect(screen.getByRole("radio", { name: "Found" }).contains(
      group.querySelector('[data-testid="segmented-selection"]')!,
    )).toBe(true);
  });
});
