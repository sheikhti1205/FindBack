// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssistantLanding, type LandingQuickAction } from "./AssistantLanding";

afterEach(cleanup);

const QUICK_ACTIONS: readonly LandingQuickAction[] = [
  { flow: "lost", label: "Report a lost item", testId: "guided-shortcut-lost" },
  { flow: "found", label: "Report a found item", testId: "guided-shortcut-found" },
  { flow: "search", label: "Search listings", testId: "guided-shortcut-search" },
];

describe("AssistantLanding FBX-020 (keyboard collapse)", () => {
  it("collapses to quick actions only when the keyboard owns the viewport", () => {
    const { rerender } = render(
      <AssistantLanding
        suggestions={["What details should I include?"]}
        quickActions={QUICK_ACTIONS}
        onSuggestion={() => {}}
        onQuickAction={() => {}}
      />,
    );
    expect(screen.getByText("Report, search, or understand something you found.")).toBeTruthy();
    expect(screen.getByText("What details should I include?")).toBeTruthy();

    rerender(
      <AssistantLanding
        suggestions={["What details should I include?"]}
        quickActions={QUICK_ACTIONS}
        onSuggestion={() => {}}
        onQuickAction={() => {}}
        compact
      />,
    );
    const landing = screen.getByTestId("assistant-landing");
    expect(landing.getAttribute("data-compact")).toBe("true");
    // Greeting + quick actions survive; subtitle + suggestions collapse away.
    expect(screen.getByRole("heading", { name: /what can i help with/i })).toBeTruthy();
    expect(screen.getByTestId("guided-shortcut-lost")).toBeTruthy();
    expect(screen.queryByText("Report, search, or understand something you found.")).toBeNull();
    expect(screen.queryByText("What details should I include?")).toBeNull();
  });
});
