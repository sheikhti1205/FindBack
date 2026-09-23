// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Shell, assistantReportNavigationTarget } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";
import {
  clearStagedAssistantReportHandoff,
  takeStagedAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";
import { applyReportFields, chooseLocation, choosePhoto, startFlow } from "../services/assistant/guidedAssistantController";
import { buildAssistantReportHandoff } from "../services/assistant/assistantHandoff";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  clearStagedAssistantReportHandoff();
  document.body.style.overflow = "";
});

function readyHandoff() {
  let snapshot = startFlow("lost");
  snapshot = applyReportFields(snapshot, {
    title: "Keys",
    category: "Keys",
    dateText: "2026-09-01",
    locationNote: "Central library",
  });
  snapshot = choosePhoto(snapshot, "none");
  snapshot = chooseLocation(snapshot, "skip");
  return buildAssistantReportHandoff(snapshot)!;
}



describe("assistantReportNavigationTarget", () => {
  it("routes the versioned handoff to /report and rejects others", () => {
    expect(assistantReportNavigationTarget(readyHandoff())).toBe("/report");
    expect(assistantReportNavigationTarget(null)).toBeNull();
    expect(assistantReportNavigationTarget({ version: 2, source: "assistant", patch: {} })).toBeNull();
  });
});

describe("Shell Review report wiring", () => {
  it("stages the handoff and navigates to /report without publishing", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<p>Home screen</p>} />
            <Route path="/report" element={<p>Report screen</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("assistant-entry"));
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Keys" } });
    fireEvent.submit(screen.getByTestId("assistant-form"));
    await screen.findAllByText(/when was the item/i);
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "2026-09-01" } });
    fireEvent.submit(screen.getByTestId("assistant-form"));
    await screen.findAllByText(/where was the item/i);
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Central library" } });
    fireEvent.submit(screen.getByTestId("assistant-form"));
    await screen.findByTestId("assistant-photo-step");
    fireEvent.click(screen.getByTestId("assistant-photo-none"));
    await screen.findByTestId("assistant-location-step");
    fireEvent.click(screen.getByTestId("assistant-location-skip"));
    const review = await screen.findByTestId("assistant-review-report");
    fireEvent.click(review);
    await screen.findByText("Report screen");
    const staged = takeStagedAssistantReportHandoff();
    expect(staged?.patch.category).toBe("Keys");
    expect(staged?.version).toBe(1);
  });
});
