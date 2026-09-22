// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Shell } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function renderShell(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<p>Home screen</p>} />
          <Route path="/help" element={<p>Help screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Shell assistant entry point", () => {
  it("shows a floating entry button on tab screens", () => {
    renderShell("/");
    expect(screen.getByTestId("assistant-entry")).toBeTruthy();
    expect(screen.getByText("Home screen")).toBeTruthy();
  });

  it("opens the assistant sheet from the entry button and closes it", () => {
    renderShell("/");
    expect(screen.queryByTestId("assistant-greeting")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-entry"));
    expect(screen.getByTestId("assistant-greeting")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-lost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("assistant-greeting")).toBeNull();
  });

  it("keeps the entry button on screens without bottom navigation", () => {
    renderShell("/help");
    expect(screen.getByTestId("assistant-entry")).toBeTruthy();
  });
});
