// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Help, type HelpAssistantDeps } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import type { NormalizedRequest, ProviderAdapter, StreamEvent } from "../services/ai/providerContract";

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-life", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(() => {
  cleanup();
  resetBackInterceptors();
  window.localStorage.clear();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

const caps = () => ({
  vision: { state: "unknown" as const },
  maxImagesPerCall: { state: "unknown" as const },
  contextTokens: { state: "unknown" as const },
  maxOutputTokens: { state: "unknown" as const },
  streaming: { state: "known" as const, value: true },
});

function renderHelp(deps: HelpAssistantDeps = {}) {
  return render(<MemoryRouter><Help deps={{ listCatalog: async () => [], ...deps }} /></MemoryRouter>);
}
function composer() {
  return screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
}
function send(question: string) {
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

/** Adapter whose stream is released by the test, so a partial really paints. */
function gatedAdapter(answer: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: NormalizedRequest[] = [];
  const adapter: ProviderAdapter & { calls: NormalizedRequest[]; release: () => void } = {
    id: "openrouter",
    capabilities: caps,
    calls,
    release: () => release(),
    async *complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
      calls.push(request);
      yield { kind: "text", attempt: 1, delta: answer };
      await gate;
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    },
  };
  return adapter;
}

describe("Help response lifecycle (pre-U6.1)", () => {
  it("A: a slow stream shows one partial, then exactly one final answer, with no stale partial", async () => {
    const adapter = gatedAdapter("Exactly one answer.");
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    send("How do I search?");
    // Partial paints while the stream is genuinely in flight.
    await screen.findByTestId("chat-partial");
    expect(screen.getByTestId("chat-partial").textContent).toContain("Exactly one answer.");
    adapter.release();
    await screen.findByText("Exactly one answer.");
    await waitFor(() => expect(screen.queryByTestId("chat-partial")).toBeNull());
    expect(screen.getAllByText("Exactly one answer.")).toHaveLength(1);
    // Still one answer well after the old 120 ms timer horizon.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByTestId("chat-partial")).toBeNull();
    expect(screen.getAllByText("Exactly one answer.")).toHaveLength(1);
  });

  it("B: a retry after a visible partial does not blend the two attempts", async () => {
    let call = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(): AsyncIterable<StreamEvent> {
        call += 1;
        if (call === 1) {
          // Both invocations label their own stream attempt 1, like a real adapter.
          yield { kind: "text", attempt: 1, delta: "SAME ANSWER" };
          yield { kind: "error", attempt: 1, code: "provider-error", message: "HTTP 503 retry-after 0", retryable: true };
          yield { kind: "done", attempt: 1, stopReason: "error" };
          return;
        }
        yield { kind: "text", attempt: 1, delta: "SAME ANSWER" };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    send("How do I search?");
    await screen.findByText("SAME ANSWER");
    await waitFor(() => expect(screen.queryByTestId("chat-partial")).toBeNull());
    expect(call).toBe(2);
    expect(screen.getAllByText("SAME ANSWER")).toHaveLength(1);
    expect(screen.queryByText("SAME ANSWERSAME ANSWER")).toBeNull();
  });

  it("D: a partial painted by a failing attempt is cleared before the built-in fallback", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(): AsyncIterable<StreamEvent> {
        yield { kind: "text", attempt: 1, delta: "half-written draft" };
        yield { kind: "error", attempt: 1, code: "provider-error", message: "upstream boom", retryable: false };
        yield { kind: "done", attempt: 1, stopReason: "error" };
      },
    };
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    send("How do I search?");
    // The app-help failure substitutes a labelled built-in answer.
    await screen.findByText("Built-in answer");
    await waitFor(() => expect(screen.queryByTestId("chat-partial")).toBeNull());
    expect(screen.queryByText("half-written draft")).toBeNull();
  });

  it("E: two synchronous sends invoke the adapter exactly once", async () => {
    const adapter = gatedAdapter("Only once.");
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    fireEvent.change(composer(), { target: { value: "double tap" } });
    const form = screen.getByTestId("chat-composer");
    // Two submits in the same tick: React busy state cannot have rerendered.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(adapter.calls.length).toBeGreaterThan(0));
    expect(adapter.calls).toHaveLength(1);
    adapter.release();
    await screen.findByText("Only once.");
    expect(screen.getAllByText("Only once.")).toHaveLength(1);
  });
});
