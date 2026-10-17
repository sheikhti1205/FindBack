// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantLanding } from "./AssistantLanding";

afterEach(cleanup);

function renderLanding(overrides: Partial<Parameters<typeof AssistantLanding>[0]> = {}) {
  const onSuggestion = vi.fn();
  render(
    <AssistantLanding
      suggestions={["What details should I include?", "How do I mark it recovered?"]}
      onSuggestion={onSuggestion}
      {...overrides}
    />,
  );
  return { onSuggestion };
}

describe("AssistantLanding (U2 conversation-first)", () => {
  it("renders a conversation greeting and suggestions, not workflow shortcuts", () => {
    renderLanding();
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /what can i help with/i })).toBeTruthy();
    expect(screen.queryByTestId(/^guided-shortcut-/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Quick actions" })).toBeNull();
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

  it("fires conversational suggestions without navigation of its own", () => {
    const { onSuggestion } = renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "What details should I include?" }));
    expect(onSuggestion).toHaveBeenCalledWith("What details should I include?");
  });

  it("uses neutral structural surfaces only (no accent tint)", () => {
    const { container } = render(
      <AssistantLanding
        suggestions={["q"]}
        onSuggestion={() => {}}
      />,
    );
    expect(container.innerHTML).toMatch(/bg-surface/);
    expect(container.innerHTML).not.toMatch(/text-(emerald|blue|violet|rose|amber|teal)-/);
  });
});
