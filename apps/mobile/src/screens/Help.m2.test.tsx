// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import type { ProviderAdapter, StreamEvent } from "../services/ai/providerContract";
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
    await screen.findByTestId("chat-cancelled");
    // Late chunks after cancel never reach the transcript.
    expect(screen.queryByText("partial…")).toBeNull();
    expect(screen.getByTestId("chat-request-state").textContent).toMatch(/cancel/i);
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
    const seen: unknown[] = [];
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
    // Placeholder models={[]} renders zero rows — this must be gone.
    const selects = await screen.findAllByRole("button", { name: /^select$/i });
    expect(selects).toHaveLength(1);
    fireEvent.click(selects[0]!);
    const header = screen.getByRole("button", { name: /choose model/i });
    const chosen = (header.textContent ?? "").trim();
    expect(chosen).not.toBe("");
    expect(chosen).not.toMatch(/^free default$/i);
    send("Hello model?");
    await screen.findByText("Model-bound hello.");
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen[0] ?? {})).toContain(chosen);
  });
});
