// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantLanding, type LandingQuickAction } from "./AssistantLanding";

afterEach(cleanup);

const QUICK_ACTIONS: readonly LandingQuickAction[] = [
  { flow: "lost", label: "Report lost", testId: "guided-shortcut-lost" },
  { flow: "found", label: "Report found", testId: "guided-shortcut-found" },
  { flow: "search", label: "Search items", testId: "guided-shortcut-search" },
];

function renderLanding(overrides: Partial<Parameters<typeof AssistantLanding>[0]> = {}) {
  const onSuggestion = vi.fn();
  const onQuickAction = vi.fn();
  render(
    <AssistantLanding
      suggestions={["What details should I include?", "How do I mark it recovered?"]}
      quickActions={QUICK_ACTIONS}
      onSuggestion={onSuggestion}
      onQuickAction={onQuickAction}
      {...overrides}
    />,
  );
  return { onSuggestion, onQuickAction };
}

describe("AssistantLanding (U2 conversation-first)", () => {
  it("renders a compact hero, at most three quick actions, and suggestion rows", () => {
    renderLanding();
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /what can i help with/i })).toBeTruthy();
    expect(screen.getByTestId("guided-shortcut-lost")).toBeTruthy();
    expect(screen.getByTestId("guided-shortcut-found")).toBeTruthy();
    expect(screen.getByTestId("guided-shortcut-search")).toBeTruthy();
    // No fake transcript entry and no legacy "Help Assistant" product name.
    expect(screen.queryByTestId("chat-message")).toBeNull();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
  });

  it("carries no product-information sections, privacy essay, or model internals", () => {
    renderLanding();
    expect(screen.queryByText(/how the assistant works/i)).toBeNull();
    expect(screen.queryByText(/popular questions/i)).toBeNull();
    expect(screen.queryByText(/privacy & ai details/i)).toBeNull();
    expect(screen.queryByText(/AI when available/)).toBeNull();
    expect(screen.queryByText(/you choose what is sent/i)).toBeNull();
  });

  it("fires suggestion and guided quick-action callbacks without navigation of its own", () => {
    const { onSuggestion, onQuickAction } = renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "What details should I include?" }));
    expect(onSuggestion).toHaveBeenCalledWith("What details should I include?");
    fireEvent.click(screen.getByTestId("guided-shortcut-lost"));
    expect(onQuickAction).toHaveBeenCalledWith("lost");
    fireEvent.click(screen.getByTestId("guided-shortcut-search"));
    expect(onQuickAction).toHaveBeenCalledWith("search");
  });

  it("uses neutral structural surfaces only (no accent tint)", () => {
    const { container } = render(
      <AssistantLanding
        suggestions={["q"]}
        quickActions={QUICK_ACTIONS}
        onSuggestion={() => {}}
        onQuickAction={() => {}}
      />,
    );
    expect(container.innerHTML).toMatch(/bg-surface/);
    expect(container.innerHTML).not.toMatch(/text-(emerald|blue|violet|rose|amber|teal)-/);
  });
});
