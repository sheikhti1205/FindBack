// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssistantLanding } from "./AssistantLanding";

afterEach(cleanup);

describe("AssistantLanding FBX-020 (keyboard collapse)", () => {
  it("collapses to the greeting when the keyboard owns the viewport", () => {
    const { rerender } = render(
      <AssistantLanding
        suggestions={["What details should I include?"]}
        onSuggestion={() => {}}
      />,
    );
    expect(screen.getByText("Ask a question or talk something through.")).toBeTruthy();
    expect(screen.getByText("What details should I include?")).toBeTruthy();

    rerender(
      <AssistantLanding
        suggestions={["What details should I include?"]}
        onSuggestion={() => {}}
        compact
      />,
    );
    const landing = screen.getByTestId("assistant-landing");
    expect(landing.getAttribute("data-compact")).toBe("true");
    // Greeting survives; subtitle and suggestions collapse for the composer.
    expect(screen.getByRole("heading", { name: /what can i help with/i })).toBeTruthy();
    expect(screen.queryByTestId(/^guided-shortcut-/)).toBeNull();
    expect(screen.queryByText("Ask a question or talk something through.")).toBeNull();
    expect(screen.queryByText("What details should I include?")).toBeNull();
  });
});
