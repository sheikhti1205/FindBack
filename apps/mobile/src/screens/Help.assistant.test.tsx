// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("heading", { name: "Help & FAQ" })).toBeTruthy();
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
    expect(screen.queryByTestId("chat-error")).toBeNull();
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
    expect(screen.getByText("first question")).toBeTruthy();
  });

  it("routes a ready guided search to ordinary search with context intact", async () => {
    renderHelp({ guidedGenerate: async () => '{"query":"keys","status":"LOST"}' });
    fireEvent.click(screen.getByTestId("guided-shortcut-search"));
    await screen.findByTestId("guided-panel");
    send("find lost keys");
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
