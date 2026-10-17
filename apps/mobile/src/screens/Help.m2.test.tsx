// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import type { NormalizedRequest, ProviderAdapter, StreamEvent } from "../services/ai/providerContract";
import { createOpenRouterAdapter } from "../services/ai/providers/openrouter";
import { buildPng } from "../services/media/__fixtures__/synthetic";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-m2", username: "tester" } }),
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

function renderHelp(deps: Record<string, unknown> = {}, entry: string | { pathname: string; state: unknown } = "/help") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
}

function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

describe("Help M2 chat UI", () => {
  it("uses the Assistant header with a model-picker affordance", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
    // U3: the send-time picker opens on Automatic first, never an empty row list.
    await screen.findByTestId("model-pick-automatic");
  });

  it("shows a real request-state row with attempt history while sending", async () => {
    renderHelp({ createAdapter: () => hangingAdapter(), getKey: async () => "test-key" });
    send("Tell me everything");
    const row = await screen.findByTestId("chat-request-state");
    expect(row.textContent).toMatch(/attempt 1/i);
    fireEvent.click(screen.getByTestId("chat-stop"));
    // P2: one consolidated status region — the cancelled state replaces (not
    // stacks on) the request-state row.
    const stopped = await screen.findByTestId("chat-cancelled");
    expect(stopped.textContent).toMatch(/stopped/i);
    // Late chunks after cancel never reach the transcript.
    expect(screen.queryByText("partial…")).toBeNull();
    expect(screen.queryByTestId("chat-request-state")).toBeNull();
  });

  it("general-chat failure renders draft + Retry with no FAQ substitution, keeping images", async () => {
    const question = "Help me solve a leetcode problem: two sum";
    renderHelp({
      createAdapter: () => failingAdapter(),
      getKey: async () => "test-key",
      importDeps: {
        transcode: async () => new Uint8Array([1, 2, 3]),
        webpEncodeSupported: false,
      },
    });
    const png = buildPng(4, 4);
    fireEvent.change(screen.getByTestId("chat-file-input"), {
      target: { files: [new File([png as unknown as BlobPart], "keys.png", { type: "image/png" })] },
    });
    await screen.findByTestId("chat-selections");
    send(question);
    await screen.findByTestId("chat-error");
    // No FAQ substitution for general chat.
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
    // Draft and images are preserved for retry.
    expect(composer().value).toBe(question);
    expect(screen.getByTestId("chat-selections")).toBeTruthy();
  });

  it("app-help failure still renders the labelled built-in answer with Retry", async () => {
    renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
    send("How do I search?");
    await screen.findByTestId("chat-error");
    expect(screen.getByText("Built-in answer")).toBeTruthy();
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
  });

  it("answers a verification-code question with the OTP help, never the lookup refusal", async () => {
    // CF-070 R2 retry-3 finding 2, through the real screen: the contact-lookup
    // branch used to run first and answer the app's own signup question with a
    // refusal to look up accounts.
    renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
    const question = "Where is my email verification code?";
    send(question);
    await screen.findByTestId("chat-error");
    expect(screen.getByText("Built-in answer")).toBeTruthy();
    expect(screen.getByText(/one-time code/i)).toBeTruthy();
    expect(screen.queryByText(/can't look up accounts/i)).toBeNull();
  });

  it("a general question that is not app help keeps the draft instead of substituting a built-in answer", async () => {
    renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
    const question = "Explain why the moon changes shape";
    send(question);
    await screen.findByTestId("chat-error");
    // Only genuine app-help intent earns the labelled built-in answer; a
    // general question that nothing in the FAQ answers must keep its draft.
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
    expect(composer().value).toBe(question);
  });

  it("a general question the FAQ would only answer with the default scope note keeps the draft", async () => {
    renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
    const question = "Tell me about the history of cheese";
    send(question);
    await screen.findByTestId("chat-error");
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(composer().value).toBe(question);
  });

  // CF-070 R2 finding 1: the predicate used to treat any FAQ keyword as app
  // help, so these questions lost their draft to an unrelated built-in answer.
  for (const question of [
    "What is photosynthesis?",
    "How do map projections distort Greenland?",
    "What does a solar eclipse look like?",
  ]) {
    it(`keeps the draft for "${question}", which only collides with a keyword`, async () => {
      renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
      send(question);
      await screen.findByTestId("chat-error");
      expect(screen.queryByText("Built-in answer")).toBeNull();
      expect(screen.getByTestId("chat-retry")).toBeTruthy();
      expect(composer().value).toBe(question);
    });
  }

  // CF-070 R2 finding 2: the banner used to render the upstream body verbatim
  // (a real OpenRouter 400 showed "max_tokens exceeds context_length").
  it("renders consumer copy for a raw provider error body, never the diagnostic text", async () => {
    const providerErrorBody = JSON.stringify({ error: { message: "max_tokens exceeds context_length" } });
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () => providerErrorBody,
    })) as unknown as typeof fetch;
    const adapter = createOpenRouterAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    const question = "Explain why the moon changes shape";
    send(question);
    const error = await screen.findByTestId("chat-error");
    expect(error.textContent).not.toMatch(/max_tokens|context_length/);
    expect(error.textContent).toMatch(/another model|try again/i);
    expect(composer().value).toBe(question);
  });

  it("falls back to safe copy when an adapter fails with an unreadable error", async () => {
    const adapter: ProviderAdapter = {
      ...failingAdapter(),
      // An adapter that throws instead of yielding an error event: whatever it
      // says is upstream text, so the banner must not repeat it.
      complete: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("socket hang up ECONNRESET")) };
        },
      }),
    };
    renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
    send("Explain why the moon changes shape");
    const error = await screen.findByTestId("chat-error");
    expect(error.textContent).not.toContain("ECONNRESET");
    expect(error.textContent).toMatch(/try again/i);
  });

  // CF-070 R2 finding 1-retry: a grammatical request about the world is not app
  // help, even when a topic word is nearby ("photos", "bell", "find").
  for (const question of [
    "How do I bake sourdough bread?",
    "Can I freeze leftover soup?",
    "How can I take better landscape photos?",
    "What is the function of a bicycle bell?",
    "How do I find the square root of 144?",
    // CF-070 R2 retry-2: app-shaped words over a world-shaped subject. Each is
    // reproduced through the real screen because the defect is composite: the
    // predicate classifies, and Help clears the composer when it says app help.
    "How do I search for peer-reviewed papers?",
    "How do I use a map to navigate a forest?",
    "How do I rate a restaurant?",
    "How do I delete my Gmail account?",
    "How does face recognition identify another person?",
    "How do I turn off Gmail notifications?",
    "How do I check my order status?",
    // CF-070 R2 retry-3: the phrase matches a topic word for word and the
    // subject is still the world, so the draft must survive the failure.
    "How do I search stock market reports?",
    "How do I write a report for school?",
    "How do I upload a photo to my passport application?",
    "How do I change the location of a meeting?",
    "How do I rate items on an employee performance review?",
    "How do I set my shop status to closed?",
    "How do I leave a comment in a PDF?",
    "How do I edit my draft for a school essay?",
    "How do I delete my account with my bank?",
    "How do I upload a photo to Instagram, not FindBack?",
    "How do I write a book report?",
    "How do I comment on a news article?",
  ]) {
    it(`keeps the draft for "${question}", which is a request about the world`, async () => {
      renderHelp({ createAdapter: () => failingAdapter(), getKey: async () => "test-key" });
      send(question);
      await screen.findByTestId("chat-error");
      expect(screen.queryByText("Built-in answer")).toBeNull();
      expect(screen.getByTestId("chat-retry")).toBeTruthy();
      expect(composer().value).toBe(question);
    });
  }

  // CF-070 R2 finding 2-retry: an adapter can claim a first-party timeout code
  // with arbitrary text, so the code alone is not proof that the message was
  // written here. Every rendered line must come from the code's fixed copy.
  for (const [code, copy] of [
    ["timeout-overall", /took too long/i],
    ["timeout-first-token", /didn't start replying/i],
    ["timeout-idle", /stopped replying partway/i],
  ] as const) {
    it(`renders fixed copy for an adapter-reported ${code}, never its message`, async () => {
      const junk = "max_tokens exceeds context_length (upstream body)";
      const adapter: ProviderAdapter = {
        ...failingAdapter(),
        complete: async function* (): AsyncIterable<StreamEvent> {
          yield { kind: "error", attempt: 1, code, message: junk, retryable: false };
          yield { kind: "done", attempt: 1, stopReason: "error" };
        },
      };
      renderHelp({ createAdapter: () => adapter, getKey: async () => "test-key" });
      const question = "Explain why the moon changes shape";
      send(question);
      const error = await screen.findByTestId("chat-error");
      expect(error.textContent).toMatch(copy);
      expect(error.textContent).not.toMatch(/max_tokens|context_length/);
      expect(composer().value).toBe(question);
    });
  }

  it("passes the full handoff prompt without slice(0,500) truncation", () => {
    const longPrompt = `Report context: ${"lost keys detail ".repeat(40)}`;
    expect(longPrompt.length).toBeGreaterThan(500);
    renderHelp({ createAdapter: () => cannedAdapter("ok") }, {
      pathname: "/help",
      state: { assistantPrompt: longPrompt, assistantSource: "report" },
    });
    expect(composer().value).toBe(longPrompt.trim());
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("sends photo-only drafts with no text", async () => {
    const seen: string[][] = [];
    const spy: ProviderAdapter = {
      ...cannedAdapter("Image noted."),
      complete: async function* (request): AsyncIterable<StreamEvent> {
        seen.push([...request.approvedImageIds]);
        yield { kind: "text", attempt: 1, delta: "Image noted." };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    renderHelp({
      createAdapter: () => spy,
      getKey: async () => "test-key",
      importDeps: {
        transcode: async () => new Uint8Array([1, 2, 3]),
        webpEncodeSupported: false,
      },
    });
    const png = buildPng(4, 4);
    fireEvent.change(screen.getByTestId("chat-file-input"), {
      target: { files: [new File([png as unknown as BlobPart], "keys.png", { type: "image/png" })] },
    });
    await screen.findByTestId("chat-selections");
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(screen.getByTestId("chat-composer"));
    await screen.findByText("Image noted.");
    expect(seen[0]?.length).toBe(1);
  });

  it("P4b: cached free row exists and selecting it drives the send-time adapter model ID", async () => {
    // WB-02 guard bans any second openrouter/... route literal in shipped
    // code, so the minimal catalogue is the single pinned free row; a
    // non-default-row proof must wait for the authenticated-catalogue packet.
    const seen: NormalizedRequest[] = [];
    const spy: ProviderAdapter = {
      ...cannedAdapter("Model-bound hello."),
      complete: async function* (request): AsyncIterable<StreamEvent> {
        seen.push(request);
        yield { kind: "text", attempt: 1, delta: "Model-bound hello." };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    renderHelp({ createAdapter: () => spy, getKey: async () => "test-key" });
    fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
    // One qualified model is cross-listed under Chat and Vision; this is
    // one model identity, not two transport choices. Pick its Chat row.
    const chat = (await screen.findByRole("heading", { name: "Chat" })).parentElement!;
    const vision = screen.getByRole("heading", { name: "Vision" }).parentElement!;
    expect(within(chat).getByText("Free model router")).toBeTruthy();
    expect(within(vision).getByText("Free model router")).toBeTruthy();
    fireEvent.click(within(chat).getByRole("button", { name: /^select$/i }));
    const header = screen.getByRole("button", { name: /choose model/i });
    // P2: the header shows the consumer display name, not the raw model ID;
    // the raw ID still drives the send-time binding asserted below.
    const chosen = (header.textContent ?? "").trim();
    expect(chosen).toBe("Free model router");
    send("Hello model?");
    await screen.findByText("Model-bound hello.");
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      selection: { provider: "openrouter", modelId: "openrouter/free" },
      currentText: "Hello model?",
      approvedImageIds: [],
    });
  });
});
