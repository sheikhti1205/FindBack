// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthShell } from "./AuthShell";
import { ThemeProvider } from "../../theme";
import { MemoryRouter } from "react-router";
import { getAuthReturnRoute, rememberAuthReturnTo } from "../../utils/authReturnTo";
import { rememberReportLink } from "../../utils/pendingReportLink";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); sessionStorage.clear(); });

describe("shared auth branding", () => {
  it("Back cancels protected and shared intent without completing onboarding", () => {
    sessionStorage.clear();
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social");
    rememberAuthReturnTo("/chats/c1");
    rememberReportLink("https://findbackapp.social/r/00000000-0000-4000-8000-000000000001");
    expect(getAuthReturnRoute()).toBe("/posts/00000000-0000-4000-8000-000000000001");
    render(<MemoryRouter><AuthShell title="Welcome"><p>Form</p></AuthShell></MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: "Back to Norfold" }));
    expect(getAuthReturnRoute()).toBe("/");
  });
  it.each([false, true])("uses only the canonical mark with illustration=%s", illustration => {
    const { container } = render(<MemoryRouter><ThemeProvider><AuthShell title="Welcome to Norfold" illustration={illustration}><p>Form content</p></AuthShell></ThemeProvider></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Welcome to Norfold" })).toBeTruthy();
    const marks = [...container.querySelectorAll("header img")];
    expect(marks).toHaveLength(illustration ? 2 : 1);
    for (const mark of marks) {
      expect(mark.getAttribute("src")).toMatch(/brand-(tile|mark)-(light|dark)/);
      expect(mark.getAttribute("alt")).toBe("");
    }
    expect(container.querySelector(".lucide-radar")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Norfold" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
  });
});
