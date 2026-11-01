// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryDemo } from "./RecoveryDemo";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("../uiMotion", () => ({ useShouldReduceMotion: () => preference.reduced }));
afterEach(() => { cleanup(); preference.reduced = false; });
describe("shared truthful recovery demonstration", () => {
  it.each([false, true])("keeps every step readable with reduced motion=%s", reduced => {
    preference.reduced = reduced; render(<RecoveryDemo />);
    const figure = screen.getByRole("figure", { name: /example recovery journey/i });
    expect(figure.getAttribute("data-motion")).toBe(reduced ? "static" : "full");
    expect(screen.getByText("Possible match")).toBeTruthy();
    expect(screen.getByText("Arrange a handover")).toBeTruthy();
    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(figure.querySelector('[data-demo-visual]')?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(figure.querySelectorAll("button,a,input")).toHaveLength(0);
  });
});
