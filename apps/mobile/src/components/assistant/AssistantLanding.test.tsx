// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantLanding, type LandingQuickAction } from "./AssistantLanding";

afterEach(cleanup);

const QUICK_ACTIONS: readonly LandingQuickAction[] = [
  { flow: "lost", label: "Report a lost item", testId: "guided-shortcut-lost" },
  { flow: "found", label: "Report a found item", testId: "guided-shortcut-found" },
  { flow: "search", label: "Search listings", testId: "guided-shortcut-search" },
];

function renderLanding(overrides: Partial<Parameters<typeof AssistantLanding>[0]> = {}) {
  const onSuggestion = vi.fn();
  const onQuickAction = vi.fn();
  render(
    <AssistantLanding
      username="tester"
      suggestions={["How do I report a lost item?", "How do I search and filter?"]}
      quickActions={QUICK_ACTIONS}
      privacyCopy="Full consent copy: photos are optional and you choose what is sent."
      onSuggestion={onSuggestion}
      onQuickAction={onQuickAction}
      {...overrides}
    />,
  );
  return { onSuggestion, onQuickAction };
}

describe("AssistantLanding (v0.9.0-beta.1)", () => {
  it("renders a compact consumer landing, not a greeting transcript bubble", () => {
    renderLanding();
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Hi tester/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /popular questions/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /quick actions/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /how the assistant works/i })).toBeTruthy();
    // No fake transcript entry and no legacy "Help Assistant" product name.
    expect(screen.queryByTestId("chat-message")).toBeNull();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
  });

  it("shows the welcome compactly and falls back when no username is known", () => {
    renderLanding({ username: null });
    expect(screen.getByRole("heading", { name: /Hi there/ })).toBeTruthy();
  });

  it("fires suggestion and guided quick-action callbacks without navigation of its own", () => {
    const { onSuggestion, onQuickAction } = renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "How do I search and filter?" }));
    expect(onSuggestion).toHaveBeenCalledWith("How do I search and filter?");
    fireEvent.click(screen.getByTestId("guided-shortcut-lost"));
    expect(onQuickAction).toHaveBeenCalledWith("lost");
    fireEvent.click(screen.getByTestId("guided-shortcut-search"));
    expect(onQuickAction).toHaveBeenCalledWith("search");
  });

  it("keeps the full consent copy collapsed but reachable in one tap", () => {
    renderLanding();
    expect(screen.queryByText(/Full consent copy/)).toBeNull();
    const disclosure = screen.getByRole("button", { name: /privacy & ai details/i });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Full consent copy/)).toBeTruthy();
  });

  it("uses neutral structural surfaces only (no accent tint)", () => {
    const { container } = render(
      <AssistantLanding
        username="tester"
        suggestions={["q"]}
        quickActions={QUICK_ACTIONS}
        privacyCopy="copy"
        onSuggestion={() => {}}
        onQuickAction={() => {}}
      />,
    );
    expect(container.innerHTML).toMatch(/bg-surface/);
    expect(container.innerHTML).not.toMatch(/text-(emerald|blue|violet|rose|amber|teal)-/);
  });
});
