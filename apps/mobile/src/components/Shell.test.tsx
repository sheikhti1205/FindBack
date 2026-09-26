// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Shell } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";

afterEach(() => { cleanup(); resetBackInterceptors(); document.body.style.overflow = ""; });

function renderShell(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route element={<Shell />}>
        <Route index element={<p>Home screen</p>} />
        <Route path="/search" element={<p>Search screen</p>} />
        <Route path="/ai-connection" element={<p>AI connection</p>} />
      </Route></Routes>
    </MemoryRouter>,
  );
}

describe("Shell tabs (no global assistant)", () => {
  it("renders exactly four tabs and no floating assistant entry", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((t) => t.textContent)).toEqual([
      "Home",
      "Search",
      "Report",
      "Profile",
    ]);
    // Owner decision 2026-09-26: the global floating AI button is removed.
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open assistant" })).toBeNull();
  });

  it("hides the bottom nav on AI connection and shows no assistant UI", () => {
    renderShell("/ai-connection");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
  });
});

describe("Shell P1 viewport (screenshots 08/11/12)", () => {
  function renderShellAt(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route element={<Shell />}>
          <Route index element={<p>Home screen</p>} />
          <Route path="/search" element={<p>Search screen</p>} />
          <Route path="/help" element={<p>Assistant screen</p>} />
          <Route path="/ai-connection" element={<p>AI connection</p>} />
        </Route></Routes>
      </MemoryRouter>,
    );
  }

  it("owns one app viewport with no phantom bottom padding on /help", () => {
    renderShellAt("/help");
    // Full-screen Assistant takes the whole viewport: no tab bar, no tab pad.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    const viewport = document.querySelector(".fb-app-viewport");
    expect(viewport).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.className).not.toMatch(/pb-20/);
    expect(main.className).toMatch(/min-h-0/);
    expect(main.className).toMatch(/flex-1/);
  });

  it("keeps the bottom nav in normal flex flow, not a fixed overlay", () => {
    renderShellAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toMatch(/fixed/);
  });
});
