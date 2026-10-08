// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { HelpGuide } from "./HelpGuide";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname + location.search}</p>;
}

function renderGuide() {
  return render(
    <MemoryRouter initialEntries={["/settings/help"]}>
      <Routes>
        <Route path="/settings/help" element={<HelpGuide />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("HelpGuide", () => {
  it("renders one h1, backs to /settings, and links every topic to a real flow", () => {
    renderGuide();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: /help/i })).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    for (const expected of [
      "/report",
      "/search",
      "/my",
      "/notifications",
      "/settings/ai/privacy",
      "/help",
      "/onboarding?replay=1",
    ]) {
      expect(hrefs).toContain(expected);
    }

    fireEvent.click(screen.getByRole("button", { name: /back to settings/i }));
    expect(screen.getByTestId("location").textContent).toBe("/settings");
  });

  it("filters topics locally with no backend", () => {
    renderGuide();

    fireEvent.change(screen.getByRole("searchbox", { name: /search help topics/i }), {
      target: { value: "notif" },
    });
    expect(screen.getByRole("link", { name: /notifications/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /replay introduction/i })).toBeNull();
  });
});
