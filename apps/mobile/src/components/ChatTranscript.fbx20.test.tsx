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

describe("ChatTranscript FBX-020 (Copy/Retry/Details response actions)", () => {
  it("offers Copy, Retry and Details on an assistant response", () => {
    const onRetryMessage = vi.fn();
    render(
      <ChatTranscript
        messages={[
          { id: "u1", role: "user", text: "How do I report?" },
          {
            id: "a1",
            role: "assistant",
            text: "Use the Report tab.",
            source: "llm",
            sourceDetail: "Test model · via Test provider",
          },
        ]}
        onRetryMessage={onRetryMessage}
      />,
    );
    // Copy …
    expect(screen.getByTestId("chat-copy-a1")).toBeTruthy();
    // … Retry (per-response regeneration) …
    const retry = screen.getByTestId("chat-retry-a1");
    expect(retry.getAttribute("aria-label")).toBe("Retry response");
    fireEvent.click(retry);
    expect(onRetryMessage).toHaveBeenCalledWith("a1");
    // … Details (provider/model provenance disclosure).
    fireEvent.click(screen.getByTestId("chat-details-a1"));
    expect(screen.getByTestId("chat-details-panel-a1").textContent).toContain(
      "Test model · via Test provider",
    );
  });

  it("never offers per-response retry on user bubbles", () => {
    render(
      <ChatTranscript
        messages={[{ id: "u1", role: "user", text: "How do I report?" }]}
        onRetryMessage={() => {}}
      />,
    );
    expect(screen.queryByTestId("chat-retry-u1")).toBeNull();
  });

  it("hides per-response retry when the caller provides no regeneration seam", () => {
    render(
      <ChatTranscript
        messages={[{ id: "a1", role: "assistant", text: "Use the Report tab.", source: "llm" }]}
      />,
    );
    expect(screen.queryByTestId("chat-retry-a1")).toBeNull();
    // Copy stays available regardless.
    expect(screen.getByTestId("chat-copy-a1")).toBeTruthy();
  });

  it("keeps the assistant turn as open flowing text, not a giant bubble", () => {
    const { container } = render(
      <ChatTranscript
        messages={[{ id: "a1", role: "assistant", text: "Use the Report tab.", source: "llm" }]}
        onRetryMessage={() => {}}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-on-surface/);
  });
});
