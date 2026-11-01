// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicLanding } from "./PublicLanding";

vi.mock("../components/uiMotion", () => ({ useShouldReduceMotion: () => true }));
afterEach(cleanup);
describe("truthful public product invitation", () => {
  it("leads with the core job and an explicitly illustrative end-to-end journey", () => {
    render(<MemoryRouter><PublicLanding /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1, name: "Report it. Match it. Return it." })).toBeTruthy();
    expect(screen.getByRole("figure", { name: /example recovery journey/i })).toBeTruthy();
    expect(screen.getByText(/illustration, not a live report/i)).toBeTruthy();
    expect(screen.getByRole("list", { name: /report to recovery/i }).textContent).toMatch(/Report.*Discover.*Match.*Contact.*Recover/s);
    expect(screen.getAllByRole("link", { name: /create an account/i }).every(a => a.getAttribute("href") === "/register")).toBe(true);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin");
    expect(document.body.textContent).not.toMatch(/\d+%|\d+\s+(recoveries|people|reports today)|(?<!not )guaranteed/i);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });
});
