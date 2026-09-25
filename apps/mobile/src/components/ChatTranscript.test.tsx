// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatTranscript } from "./ChatTranscript";

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(cleanup);

describe("ChatTranscript", () => {
  it("renders user and assistant turns with honest source labels", () => {
    render(
      <ChatTranscript
        messages={[
          { id: "u1", role: "user", text: "How do I report?" },
          { id: "a1", role: "assistant", text: "Use the Report tab.", source: "llm" },
          { id: "a2", role: "assistant", text: "Built-in fallback.", source: "fallback" },
        ]}
      />,
    );
    const log = screen.getByTestId("chat-transcript");
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("How do I report?")).toBeTruthy();
    expect(screen.getByText("Generated via OpenRouter free model")).toBeTruthy();
    expect(screen.getByText("Built-in answer")).toBeTruthy();
  });

  it("shows busy state with a stop action and surfaces errors with retry", () => {
    const onStop = vi.fn();
    const onRetry = vi.fn();
    render(
      <ChatTranscript messages={[]} busy onStop={onStop} error="Send failed." onRetry={onRetry} />,
    );
    expect(screen.getByTestId("chat-stop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chat-error").textContent).toContain("Send failed.");
    fireEvent.click(screen.getByTestId("chat-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the compaction notice without markup", () => {
    render(
      <ChatTranscript
        messages={[]}
        notice="Older messages are summarized (4 of 10); recent messages are sent verbatim."
      />,
    );
    expect(screen.getByTestId("chat-notice").textContent).toContain("summarized (4 of 10)");
  });

  it("renders action chips that navigate on activation", () => {
    const onAction = vi.fn();
    render(
      <ChatTranscript
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "See also.",
            source: "fallback",
            actions: [{ id: "OPEN_SEARCH", label: "Open search" }],
          },
        ]}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open search" }));
    expect(onAction).toHaveBeenCalledWith("OPEN_SEARCH");
  });

  it("keeps a bottom anchor so long streamed responses do not break scroll", () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      role: "assistant" as const,
      text: `Response chunk ${i} `.repeat(20),
      source: "llm" as const,
    }));
    const { container } = render(<ChatTranscript messages={messages} />);
    expect(screen.getByTestId("chat-bottom")).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="chat-message"]').length).toBe(60);
    const scroller = screen.getByTestId("chat-transcript");
    expect(scroller.className).toContain("overflow-y-auto");
  });

  it("uses grayscale surfaces with colour only on meaningful status", () => {
    const { container } = render(
      <ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />,
    );
    const scroller = screen.getByTestId("chat-transcript");
    expect(scroller.className).toMatch(/bg-surface|surface-container/);
    expect(container.innerHTML).not.toMatch(/text-(red|green|blue|amber|emerald)-/);
  });
});
