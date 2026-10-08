// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { ChatTranscript } from "./ChatTranscript";
import { clearDiagEvents, getDiagEvents, setDiagEnabled } from "../services/diag";

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => { cleanup(); setDiagEnabled(false); clearDiagEvents(); });

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
    // M2 G08: without provider/model provenance the label stays generic.
    expect(screen.getByText("AI answer")).toBeTruthy();
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

  it("keeps a bottom anchor so long streamed responses do not break scroll", () => {    const messages = Array.from({ length: 60 }, (_, i) => ({
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

  it("auto-follows instantly rather than restarting smooth travel on every chunk", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    render(<ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("collapses the scroll to instant when the OS prefers reduced motion", () => {
    // Declared after the full-motion case on purpose: the shared reduced-motion
    // singleton is initialized by whichever test renders first, and the live
    // `shouldReduceMotion()` read taken at scroll time is what makes the
    // instant path observable here.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      render(<ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe("ChatTranscript M2", () => {
  it("renders an in-flight partial reply with its own label", () => {
    render(
      <ChatTranscript
        messages={[{ id: "u1", role: "user", text: "hi" }]}
        partialText="Hello wo"
        partialLabel="AI answer"
      />,
    );
    const partial = screen.getByTestId("chat-partial");
    expect(partial.textContent).toContain("Hello wo");
    expect(partial.textContent).toContain("AI answer");
  });

  it("hides the partial bubble when there is no in-flight text", () => {
    render(<ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />);
    expect(screen.queryByTestId("chat-partial")).toBeNull();
  });

  it("prefers the actual provider/model label and falls back to generic AI", () => {
    const { rerender } = render(
      <ChatTranscript
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "hi",
            source: "llm",
            sourceDetail: "openrouter · llama-3.2",
          },
        ]}
      />,
    );
    expect(screen.getByText("openrouter · llama-3.2")).toBeTruthy();
    rerender(
      <ChatTranscript
        messages={[{ id: "a1", role: "assistant", text: "hi", source: "llm" }]}
      />,
    );
    expect(screen.getByText("AI answer")).toBeTruthy();
  });
});

describe("ChatTranscript P1 layout (screenshots 10/12)", () => {
  it("keeps provenance labels at readable size (Standard AA, no 10px metadata)", () => {
    render(
      <ChatTranscript
        messages={[{ id: "a1", role: "assistant", text: "hi", source: "llm" }]}
      />,
    );
    const label = screen.getByText("AI answer");
    expect(label.className).not.toMatch(/text-\[10px\]/);
  });

  it("owns the transcript scroll inside a bounded flex column", () => {
    render(<ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />);
    const scroller = screen.getByTestId("chat-transcript");
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/);
    expect(scroller.className).toMatch(/flex-1/);
  });
});

describe("ChatTranscript motion (Wave E)", () => {
  it("settles restored history and rises only the newly appended turn", async () => {
    const view = render(
      <ChatTranscript messages={[{ id: "u1", role: "user", text: "How do I report?" }]} />,
    );
    const restored = screen.getByTestId("chat-message");
    // Restored history renders settled — the entrance never replays.
    expect(restored.style.opacity).not.toBe("0");

    view.rerender(
      <ChatTranscript
        messages={[
          { id: "u1", role: "user", text: "How do I report?" },
          { id: "a1", role: "assistant", text: "Use the Report tab.", source: "llm" },
        ]}
      />,
    );
    const nodes = screen.getAllByTestId("chat-message");
    expect(nodes).toHaveLength(2);
    // History is reused, not remounted, so only the new turn animates.
    expect(nodes[0]).toBe(restored);
    expect(nodes[1]!.style.opacity).toBe("0");
    expect(nodes[1]!.style.transform).toContain("translateY");
    await waitFor(() => expect(nodes[1]!.style.opacity).toBe("1"), { timeout: 2000 });
    expect(nodes[1]!.textContent).toContain("Use the Report tab.");
  });

  it("fades the busy row out as the finished answer arrives", async () => {
    const view = render(
      <ChatTranscript messages={[]} busy busyLabel="Thinking…" onStop={() => {}} />,
    );
    expect(screen.getByTestId("chat-busy").textContent).toContain("Thinking…");
    view.rerender(
      <ChatTranscript
        messages={[{ id: "a1", role: "assistant", text: "All done.", source: "llm" }]}
        busy={false}
      />,
    );
    // The answer is readable immediately; the spinner row then leaves cleanly.
    expect(screen.getByText("All done.")).toBeTruthy();
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-busy"));
    expect(screen.getByText("All done.")).toBeTruthy();
  });

  it("swaps the copy icon to a check briefly instead of toasting", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <ChatTranscript messages={[{ id: "a1", role: "assistant", text: "answer text", source: "llm" }]} />,
    );
    const button = screen.getByTestId("chat-copy-a1");
    expect(button.getAttribute("aria-label")).toBe("Copy answer");
    expect(screen.getByTestId("chat-copy-icon-copy")).toBeTruthy();

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("answer text");
    expect(await screen.findByTestId("chat-copy-icon-check")).toBeTruthy();
    // The copy glyph crossfades out; it does not vanish in the same frame.
    await waitFor(() => expect(screen.queryByTestId("chat-copy-icon-copy")).toBeNull());
    expect(screen.getByTestId("chat-copy-a1").getAttribute("aria-label")).toBe("Copied");
    expect(screen.getByText("Copied")).toBeTruthy();
    expect(screen.queryByText(/toast/i)).toBeNull();

    // …and reverts on its own without a second interaction.
    await waitFor(() => expect(screen.queryByTestId("chat-copy-icon-check")).toBeNull(), {
      timeout: 4000,
    });
    expect(screen.getByTestId("chat-copy-a1").getAttribute("aria-label")).toBe("Copy answer");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("keeps one partial bubble across streamed updates (tokens never animate)", () => {
    const view = render(
      <ChatTranscript
        messages={[{ id: "u1", role: "user", text: "hi" }]}
        partialText="Hel"
        partialLabel="AI answer"
      />,
    );
    const bubble = screen.getByTestId("chat-partial");
    expect(bubble.textContent).toContain("Hel");
    view.rerender(
      <ChatTranscript
        messages={[{ id: "u1", role: "user", text: "hi" }]}
        partialText="Hello world, streaming…"
        partialLabel="AI answer"
      />,
    );
    // Same node: the text grows in place with no re-mount and no re-entrance.
    expect(screen.getByTestId("chat-partial")).toBe(bubble);
    expect(bubble.textContent).toContain("Hello world, streaming…");
  });
});

describe("ChatTranscript scroll-to-latest control (U2)", () => {
  it("shows a floating control with an unseen dot instead of a centered pill", async () => {
    const view = render(
      <ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />,
    );
    const scroller = screen.getByTestId("chat-transcript");
    // Simulate a genuinely scrolled-up conversation so the control is warranted.
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 0, configurable: true, writable: true });
    fireEvent.wheel(scroller, { deltaY: -100 });
    view.rerender(
      <ChatTranscript
        messages={[
          { id: "u1", role: "user", text: "hi" },
          { id: "a1", role: "assistant", text: "answer", source: "llm" },
        ]}
      />,
    );
    const control = await screen.findByTestId("chat-scroll-latest");
    expect(control).toBeTruthy();
    // No centered pill anywhere; the dot marks unseen response content.
    expect(screen.queryByTestId("chat-new-response")).toBeNull();
    expect(screen.getByTestId("chat-scroll-latest-dot")).toBeTruthy();
    // Switching to a brand-new empty chat must clear it — never stale.
    view.rerender(<ChatTranscript messages={[]} />);
    await waitFor(() => expect(screen.queryByTestId("chat-scroll-latest")).toBeNull());
  });

  it("hides the control during active scrolling and restores it on idle", async () => {
    const view = render(
      <ChatTranscript messages={[{ id: "u1", role: "user", text: "hi" }]} />,
    );
    const scroller = screen.getByTestId("chat-transcript");
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 0, configurable: true, writable: true });
    fireEvent.wheel(scroller, { deltaY: -100 });
    view.rerender(
      <ChatTranscript
        messages={[
          { id: "u1", role: "user", text: "hi" },
          { id: "a1", role: "assistant", text: "answer", source: "llm" },
        ]}
      />,
    );
    await screen.findByTestId("chat-scroll-latest");
    fireEvent.scroll(scroller);
    // The control leaves with an exit fade, then the 200 ms scroll-idle
    // timer brings it back while still away from the bottom.
    await waitFor(() => expect(screen.queryByTestId("chat-scroll-latest")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("chat-scroll-latest")).toBeTruthy(), {
      timeout: 2000,
    });
  });
});

describe("ChatTranscript streaming follow intent", () => {
  function geometry(el: HTMLElement, top: number, height = 1000) {
    Object.defineProperties(el, {
      scrollHeight: { value: height, configurable: true },
      clientHeight: { value: 200, configurable: true },
      scrollTop: { value: top, configurable: true, writable: true },
    });
  }

  it("measures committed partial paints separately from scheduled updates using numeric-only metrics", () => {
    setDiagEnabled(true);
    const messages = [{ id: "private-turn", role: "user" as const, text: "private prompt" }];
    const view = render(<ChatTranscript messages={messages} partialText="private output" />);
    view.rerender(<ChatTranscript messages={messages} partialText="private output continued" />);
    view.rerender(<ChatTranscript messages={messages} partialText="private output continued" />);
    view.rerender(<ChatTranscript messages={messages} partialText={null} />);
    const events = getDiagEvents().filter(e => e.event.startsWith("ai.stream.transcript"));
    expect(events.map(e => e.fields.paintCount)).toEqual([1, 2, 2]);
    expect(events.every(e => Object.values(e.fields).every(v => typeof v === "number"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("keeps following when content grows beyond the bottom threshold", () => {
    const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
    const view = render(<ChatTranscript messages={[]} partialText="first" />);
    geometry(screen.getByTestId("chat-transcript"), 800, 1500);
    scroll.mockClear();
    view.rerender(<ChatTranscript messages={[]} partialText="first plus a large real chunk" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto" });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();
  });

  it.each(["touch", "keyboard"])("%s upward intent suspends follow before a scroll event arrives", input => {
    const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
    const messages = [{ id: "u", role: "user" as const, text: "hi" }];
    const view = render(<ChatTranscript messages={messages} partialText="first" />);
    const el = screen.getByTestId("chat-transcript"); geometry(el, 800);
    if (input === "touch") {
      fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(el, { touches: [{ clientY: 110 }] });
    } else fireEvent.keyDown(el, { key: "ArrowUp" });
    scroll.mockClear();
    view.rerender(<ChatTranscript messages={messages} partialText="first more" />);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("does not resume for a programmatic downward scroll, but resets when the conversation clears", () => {
    const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
    const messages = [{ id: "u", role: "user" as const, text: "hi" }];
    const view = render(<ChatTranscript messages={messages} partialText="first" />);
    const el = screen.getByTestId("chat-transcript"); geometry(el, 790);
    fireEvent.wheel(el, { deltaY: -10 });
    el.scrollTop = 800; fireEvent.scroll(el); // No downward user intent.
    scroll.mockClear();
    view.rerender(<ChatTranscript messages={messages} partialText="first more" />);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<ChatTranscript messages={[]} />);
    view.rerender(<ChatTranscript messages={messages} partialText="new" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("upward movement inside 96px stops follow until genuine downward scrolling reaches bottom", () => {
    const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
    const messages = [{ id: "u", role: "user" as const, text: "hi" }];
    const view = render(<ChatTranscript messages={messages} partialText="first" />);
    const el = screen.getByTestId("chat-transcript"); geometry(el, 800);
    fireEvent.scroll(el); // Establish current bottom; no user movement yet.
    fireEvent.wheel(el, { deltaY: -10 }); el.scrollTop = 790; fireEvent.scroll(el);
    scroll.mockClear();
    view.rerender(<ChatTranscript messages={messages} partialText="first more" />);
    expect(scroll).not.toHaveBeenCalled();
    // Layout/programmatic scroll at the same position cannot re-enable follow.
    fireEvent.scroll(el);
    view.rerender(<ChatTranscript messages={messages} partialText="first more still" />);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.wheel(el, { deltaY: 10 }); el.scrollTop = 800; fireEvent.scroll(el);
    view.rerender(<ChatTranscript messages={messages} partialText="first more still latest" />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it.each([false, true])("explicit latest tap is smooth only without reduced motion (%s)", async reduced => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: reduced, addEventListener() {}, removeEventListener() {} });
    try {
      const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
      render(<ChatTranscript messages={[{ id: "u", role: "user", text: "hi" }]} />);
      const el = screen.getByTestId("chat-transcript"); geometry(el, 790);
      fireEvent.wheel(el, { deltaY: -10 }); fireEvent.scroll(el);
      // Do not click the outgoing AnimatePresence node during scroll idle.
      await waitFor(() => expect(screen.queryByTestId("chat-scroll-latest")).toBeNull());
      const button = await screen.findByTestId("chat-scroll-latest");
      scroll.mockClear(); fireEvent.click(button);
      expect(scroll).toHaveBeenCalledWith({ behavior: reduced ? "auto" : "smooth" });
    } finally { window.matchMedia = original; }
  });
});
