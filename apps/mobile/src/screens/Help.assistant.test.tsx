// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import { takeStagedAssistantReportHandoff } from "../services/assistant/assistantReportNavigation";
import type { ProviderAdapter, StreamEvent } from "../services/ai/providerContract";
import { buildPng } from "../services/media/__fixtures__/synthetic";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-h2", username: "tester" } }),
}));

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  (URL as unknown as Record<string, unknown>).createObjectURL = () => "blob:chat-preview";
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function cannedAdapter(answer: string): ProviderAdapter {
  return {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "known", value: true },
      maxImagesPerCall: { state: "known", value: 10 },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    complete: async function* (): AsyncIterable<StreamEvent> {
      yield { kind: "text", attempt: 1, delta: answer };
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    },
  };
}

function hangingAdapter(): ProviderAdapter {
  return {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    complete: async function* (request): AsyncIterable<StreamEvent> {
      yield { kind: "text", attempt: 1, delta: "partial…" };
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (request.signal.aborted) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      yield { kind: "done", attempt: 1, stopReason: "cancelled" };
    },
  };
}

function failingAdapter(): ProviderAdapter {
  return {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    complete: async function* (): AsyncIterable<StreamEvent> {
      yield { kind: "error", attempt: 1, code: "provider-error", message: "boom", retryable: false };
      yield { kind: "done", attempt: 1, stopReason: "error" };
    },
  };
}

function renderHelp(deps: Record<string, unknown> = {}, entry = "/help") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
        <Route path="/search" element={<p>Search screen</p>} />
        <Route path="/report" element={<p>Report screen</p>} />
        <Route path="/profile" element={<p>Profile screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

describe("Help full-screen assistant", () => {
  it("renders transcript, composer, history entry and keeps product copy", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByTestId("chat-transcript")).toBeTruthy();
    expect(screen.getByTestId("chat-composer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /chat history/i })).toBeTruthy();
    expect(screen.getByText(/I am the FindBack Help & FAQ/)).toBeTruthy();
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
  });

  it("sends through the provider and persists the turn in this account's history", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("Report from the Report tab."), getKey: async () => "test-key" });
    send("How do I report?");
    await screen.findByText("Report from the Report tab.");
    expect(screen.getByText("How do I report?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /chat history/i }));
    await screen.findByTestId("history-sheet");
    expect(screen.getByTestId("history-sheet").textContent).toMatch(/how do i report/i);
  });

  it("falls back to a built-in answer without a connected key", async () => {
    renderHelp({ getKey: async () => null });
    send("How do I report a lost item?");
    await waitFor(() => expect(screen.getByText("Built-in answer")).toBeTruthy());
  });

  it("stops a running send and keeps the draft", async () => {
    renderHelp({ createAdapter: () => hangingAdapter(), getKey: async () => "test-key" });
    send("Tell me everything");
    await screen.findByTestId("chat-stop");
    fireEvent.click(screen.getByTestId("chat-stop"));
    await screen.findByTestId("chat-cancelled");
    expect((screen.getByLabelText("Ask the Help & FAQ") as HTMLInputElement).value).toBe(
      "Tell me everything",
    );
  });

  it("surfaces provider errors with retry and keeps the transcript intact", async () => {
    // The controller keeps one adapter instance: script it to fail once, then
    // recover, so retry exercises a real second attempt.
    let calls = 0;
    const fail = failingAdapter();
    const ok = cannedAdapter("Use the Search tab.");
    const flaky: ProviderAdapter = {
      ...fail,
      complete: (request) => {
        calls += 1;
        return (calls === 1 ? fail : ok).complete(request);
      },
    };
    renderHelp({ getKey: async () => "test-key", createAdapter: () => flaky });
    send("How do I search?");
    await screen.findByTestId("chat-error");
    expect(screen.getByText("How do I search?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-retry"));
    await screen.findByText("Use the Search tab.");
    // The error row is dismissed with an exit animation — wait for the node to
    // leave the DOM instead of asserting synchronously.
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-error"));
  });

  it("opens history as a popup supporting new, continue, rename, delete and clear", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok"), getKey: async () => "test-key" });
    send("first question");
    await screen.findByText("ok");
    fireEvent.click(screen.getByRole("button", { name: /chat history/i }));
    await screen.findByTestId("history-sheet");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: /chat history/i }));
    await waitFor(() => {
      const items = screen.getAllByTestId("history-item");
      expect(items.length).toBe(2);
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue .*first question/i }));
    // The sheet now plays an exit animation (A-owned BottomSheet): wait for
    // the close instead of asserting synchronously.
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(screen.getByText("first question")).toBeTruthy();
  });

  it("routes a ready guided search to ordinary search only after an explicit tap", async () => {
    renderHelp({ guidedGenerate: async () => '{"query":"keys","status":"LOST"}' });
    fireEvent.click(screen.getByTestId("guided-shortcut-search"));
    await screen.findByTestId("guided-panel");
    send("find lost keys");
    // Ready snapshot must NOT navigate by itself: an explicit CTA appears.
    await screen.findByTestId("guided-open-search");
    expect(screen.queryByText("Search screen")).toBeNull();
    fireEvent.click(screen.getByTestId("guided-open-search"));
    await screen.findByText("Search screen");
  });

  it("stages a guided report handoff and navigates to /report without publishing", async () => {
    renderHelp({ guidedGenerate: async (prompt: string) => prompt });
    fireEvent.click(screen.getByTestId("guided-shortcut-lost"));
    await screen.findByTestId("guided-panel");
    send("Keys");
    await screen.findAllByText(/when was the item/i);
    send("2026-09-01");
    await screen.findAllByText(/where was the item/i);
    send("Central library");
    await screen.findByTestId("guided-photo-step");
    fireEvent.click(screen.getByTestId("guided-photo-none"));
    await screen.findByTestId("guided-location-step");
    fireEvent.click(screen.getByTestId("guided-location-skip"));
    fireEvent.click(await screen.findByTestId("guided-review-report"));
    await screen.findByText("Report screen");
    expect(takeStagedAssistantReportHandoff()?.patch.category).toBe("Keys");
  });

  it("selects up to ten chat images with previews and sends their ids", async () => {
    const seen: string[][] = [];
    const spyAdapter: ProviderAdapter = {
      ...cannedAdapter("Image noted."),
      complete: async function* (request): AsyncIterable<StreamEvent> {
        seen.push([...request.approvedImageIds]);
        yield { kind: "text", attempt: 1, delta: "Image noted." };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    renderHelp({
      createAdapter: () => spyAdapter,
      getKey: async () => "test-key",
      importDeps: {
        transcode: async () => new Uint8Array([1, 2, 3]),
        webpEncodeSupported: false,
      },
    });
    const png = buildPng(4, 4);
    const file = new File([png as unknown as BlobPart], "keys.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("chat-file-input"), { target: { files: [file] } });
    await screen.findByTestId("chat-selections");
    expect(screen.getByTestId("chat-selections").querySelectorAll("img").length).toBe(1);
    send("Is this my key?");
    await screen.findByText("Image noted.");
    expect(seen[0]?.length).toBe(1);
  });

  it("prefills the composer from Report/Search navigation state without auto-sending", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/help",
            state: { assistantPrompt: "Help me describe a lost key", assistantSource: "report" },
          },
        ]}
      >
        <Routes>
          <Route path="/help" element={<Help deps={{ createAdapter: () => cannedAdapter("ok") }} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((screen.getByLabelText("Ask the Help & FAQ") as HTMLInputElement).value).toBe(
      "Help me describe a lost key",
    );
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("exposes keyboard navigation landmarks and grayscale surfaces", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    expect(screen.getByRole("link", { name: /skip to composer/i })).toBeTruthy();
    expect(screen.getByRole("main", { name: /help conversation/i })).toBeTruthy();
    const scroller = screen.getByTestId("chat-transcript");
    expect(scroller.className).toMatch(/bg-surface|surface-container/);
  });
});

describe("Help P1 header/layout (screenshots 10/11/12)", () => {
  it("uses a compact two-row header with history + overflow and no header Clear", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    const header = screen.getByRole("banner");
    expect(header.className).toMatch(/shrink-0/);
    // Title truncates instead of squeezing; actions stay fixed-size.
    expect(screen.getByRole("heading", { name: "Assistant" }).className).toMatch(/truncate/);
    // Clear lives in HistorySheet/overflow, never as a crowded header button.
    expect(screen.queryByRole("button", { name: /^clear chat/i })).toBeNull();
    expect(screen.getByRole("button", { name: /chat history/i })).toBeTruthy();
    const overflow = screen.getByRole("button", { name: /more options/i });
    expect(overflow.className).toMatch(/min-h-\[48px\]/);
    // Second row carries connection status + the live model chip.
    expect(screen.getByTestId("assistant-header-subrow")).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose model/i })).toBeTruthy();
    fireEvent.click(overflow);
    await screen.findByText("Assistant options");
    expect(screen.getByRole("button", { name: /clear chat view/i })).toBeTruthy();
  });

  it("shows starter suggestions only on an empty conversation", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok"), getKey: async () => "test-key" });
    expect(screen.getByRole("button", { name: "How do I report a lost item?" })).toBeTruthy();
    send("How do I report?");
    await screen.findByText("ok");
    expect(screen.queryByRole("button", { name: "How do I report a lost item?" })).toBeNull();
    expect(screen.queryByTestId("guided-shortcut-search")).toBeNull();
  });

  it("collapses the privacy paragraph into an accessible disclosure once chatting", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok"), getKey: async () => "test-key" });
    // First use: the full consent copy is visible up front.
    expect(screen.getByText(/Photos are never attached automatically/)).toBeTruthy();
    send("How do I report?");
    await screen.findByText("ok");
    // Ongoing chat: a short disclosure replaces the permanent paragraph.
    expect(screen.queryByText(/Photos are never attached automatically/)).toBeNull();
    const disclosure = screen.getByRole("button", { name: /how your data is used/i });
    expect(disclosure.className).toMatch(/min-h-\[48px\]/);
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Photos are never attached automatically/)).toBeTruthy();
    // Collapsing plays the accordion exit before the copy leaves the DOM.
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await waitForElementToBeRemoved(() =>
      screen.queryByText(/Photos are never attached automatically/),
    );
  });

  it("brings the guided panel in and out instead of snapping it", async () => {
    renderHelp({ guidedGenerate: async () => '{"query":"keys","status":"LOST"}' });
    fireEvent.click(screen.getByTestId("guided-shortcut-search"));
    const panel = await screen.findByTestId("guided-panel");
    expect(panel.getAttribute("aria-label")).toBe("Guided help");
    fireEvent.click(screen.getByRole("button", { name: /end guided help/i }));
    await waitForElementToBeRemoved(() => screen.queryByTestId("guided-panel"));
    expect(screen.getByTestId("chat-transcript")).toBeTruthy();
    expect(screen.getByTestId("chat-composer")).toBeTruthy();
  });

  it("P2 red: app-help fail-then-retry does not duplicate persisted fallback turns", async () => {
    // App-help failure persists user + built-in fallback, then offers Retry.
    // Retry must replace that saved fallback attempt, not append a second
    // user+assistant pair (screenshots 10/12 duplicate).
    let calls = 0;
    const fail = failingAdapter();
    const ok = cannedAdapter("Use the Search tab.");
    const flaky: ProviderAdapter = {
      ...fail,
      complete: (request) => {
        calls += 1;
        return (calls === 1 ? fail : ok).complete(request);
      },
    };
    renderHelp({ getKey: async () => "test-key", createAdapter: () => flaky });
    send("How do I search?");
    await screen.findByTestId("chat-error");
    fireEvent.click(screen.getByTestId("chat-retry"));
    await screen.findByText("Use the Search tab.");
    // The error row is dismissed with an exit animation — wait for the node to
    // leave the DOM instead of asserting synchronously.
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-error"));
    // One logical reply: the user question persisted exactly once.
    expect(screen.getAllByText("How do I search?").length).toBe(1);
  });
});
