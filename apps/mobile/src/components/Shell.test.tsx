// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Shell, assistantSearchNavigationTarget, shouldShowAssistantFab } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";
import { applySearchFields, startFlow } from "../services/assistant/guidedAssistantController";

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

describe("Shell assistant entry", () => {
  it("opens the assistant on a tab screen and closes it without requiring a local model", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    expect(screen.getByTestId("assistant-greeting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("assistant-greeting")).toBeNull();
  });

  it("hides the assistant on AI connection and routes ready search filters to ordinary search", () => {
    renderShell("/ai-connection");
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
    expect(shouldShowAssistantFab("/ai-connection")).toBe(false);
    const ready = applySearchFields(startFlow("search"), { query: "keys" });
    expect(assistantSearchNavigationTarget(ready)).toBe("/search?q=keys");
    expect(assistantSearchNavigationTarget(startFlow("search"))).toBeNull();
  });
});
