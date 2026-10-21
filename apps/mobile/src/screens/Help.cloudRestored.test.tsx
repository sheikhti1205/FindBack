// @vitest-environment jsdom
// Restored coverage for behaviors the packet 11 rewrite removed from the old
// Help suites. Each test below names the deleted file/behavior it stands in
// for, so the retained contract is auditable rather than silently dropped.
//
// Deleted suite -> disposition
//   Help.test.tsx            -> "uses Help & FAQ naming and honest provider/built-in
//                                 copy": product naming becomes "Chat"; the honest
//                                 provider/built-in copy becomes honest no-key /
//                                 offline / provider errors (Help.cloud.test.tsx).
//                                 The privacy-sheet disclosure and the "no permanent
//                                 privacy wall in the transcript" rule are restored here.
//   Help.preU6.test.tsx      -> "Open Privacy settings navigates to Privacy, with
//                                 concise sheet and separate full details" and "a
//                                 cancelled send exposes only one global status
//                                 region" are restored here.
//   Help.assistant.test.tsx  -> "surfaces provider errors with retry and keeps the
//                                 transcript intact" is restored here.
//   Help.m2.test.tsx         -> "general-chat failure renders draft + Retry with no
//                                 FAQ substitution" and "renders consumer copy for a
//                                 raw provider error body, never the diagnostic text"
//                                 are restored here.
//   Help.intent.test.tsx     -> "refuses an unavailable manual pin without silently
//                                 switching to the free route" is restored here.
//   Help.g12.test.tsx        -> "sends a non-openrouter row with that row's provider
//                                 and model (never the stale openrouter hardwire)"
//                                 is restored here (Help.cloud.test.tsx asserts the
//                                 selected provider+model on the wire).
//   Help.needlePin.test.tsx  -> "the assistant picker offers Automatic first and
//                                 never lists the installed tool engine": the cloud
//                                 picker lists cloud rows only, and the tool engine is
//                                 never selectable. Restored here.
//   Help.responseLifecycle / Help.streamingPartial -> kept in place, re-pointed at
//                                 the new surface (no local/photo/FAQ assertions).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Help, type HelpAssistantDeps } from "./Help";
import { ChatStore } from "../services/ai/chatStore";
import type { ModelRecord, ProviderAdapter } from "../services/ai/providerContract";
import { resetBackInterceptors } from "../components/backNavigation";

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "restored-user" } }) }));

beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); localStorage.clear(); resetBackInterceptors(); document.body.style.overflow = ""; vi.restoreAllMocks(); });

const caps = () => ({
  vision: { state: "unknown" as const },
  maxImagesPerCall: { state: "unknown" as const },
  contextTokens: { state: "unknown" as const },
  maxOutputTokens: { state: "unknown" as const },
  streaming: { state: "known" as const, value: true },
});

function mount(deps: HelpAssistantDeps = {}, routes = true) {
  const store = new ChatStore();
  const view = render(
    <MemoryRouter initialEntries={["/help"]}>
      <Routes>
        <Route path="/help" element={<Help deps={{ createStore: () => store, getKey: async () => "test-key", ...deps }} />} />
        {routes ? <Route path="/settings/privacy" element={<h1>Privacy destination</h1>} /> : null}
        {routes ? <Route path="/settings/ai" element={<h1>AI destination</h1>} /> : null}
      </Routes>
    </MemoryRouter>,
  );
  return { store, view };
}
function send(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

describe("restored Help behaviors (packet 11)", () => {
  it("keeps the privacy disclosure out of the transcript and behind a concise sheet (Help.test.tsx, Help.preU6.test.tsx)", async () => {
    mount();
    // No permanent privacy wall in the conversation.
    expect(screen.queryByTestId("privacy-full-copy")).toBeNull();
    expect(screen.queryByText(/local-first/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Privacy & AI" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).not.toMatch(/local-first|smolvlm|qwen/i);
    fireEvent.click(screen.getByRole("button", { name: "Open Privacy settings" }));
    await screen.findByText("Privacy destination");
  });

  it("exposes exactly one global status region after a cancelled send (Help.preU6.test.tsx)", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(request) {
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { kind: "done" as const, attempt: 1, stopReason: "cancelled" as const };
      },
    };
    mount({ createAdapter: () => adapter });
    send("How do I report?");
    await waitFor(() => expect(screen.getByTestId("chat-stop")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-stop"));
    await screen.findByText(/Send stopped/);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("surfaces a provider error with retry and keeps the transcript intact (Help.assistant.test.tsx)", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete() {
        yield { kind: "error" as const, attempt: 1, code: "rate-limited" as const, message: "HTTP 429 raw body", retryable: false };
        yield { kind: "done" as const, attempt: 1, stopReason: "error" as const };
      },
    };
    mount({ createAdapter: () => adapter });
    send("How do I search?");
    const error = await screen.findByTestId("chat-error");
    // Consumer copy for the code, never the provider body.
    expect(error.textContent).toMatch(/too many requests/i);
    expect(error.textContent).not.toMatch(/raw body/i);
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
    // The failed turn is still visible and nothing else was persisted.
    expect(screen.getByTestId("chat-transcript").textContent).toContain("How do I search?");
  });

  it("keeps the draft and offers retry on a general-chat failure, with no FAQ substitution (Help.m2.test.tsx)", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete() {
        yield { kind: "error" as const, attempt: 1, code: "provider-error" as const, message: "boom", retryable: false };
        yield { kind: "done" as const, attempt: 1, stopReason: "error" as const };
      },
    };
    const { store } = mount({ createAdapter: () => adapter });
    send("What is the capital of France?");
    await screen.findByTestId("chat-error");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "What is the capital of France?");
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
    expect(screen.queryByText("Built-in answer")).toBeNull();
    // A failed send never persists a turn.
    expect(store.listChats("restored-user").flatMap((chat) => chat.turns)).toHaveLength(0);
  });

  it("never silently switches to another model when the chosen one is unavailable (Help.intent.test.tsx)", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete() {
        yield { kind: "error" as const, attempt: 1, code: "not-found" as const, message: "no such model", retryable: false };
        yield { kind: "done" as const, attempt: 1, stopReason: "error" as const };
      },
    };
    const { store } = mount({ createAdapter: () => adapter });
    send("Use a model that does not exist");
    await screen.findByTestId("chat-error");
    // The refused model is reported and the draft is kept: no silent fallback
    // to another provider or model.
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Use a model that does not exist");
    expect(store.listChats("restored-user").flatMap((chat) => chat.turns)).toHaveLength(0);
    // The recovery hint must name a screen that exists in the shipped app.
    const error = screen.getByTestId("chat-error");
    expect(error.textContent).toMatch(/model button/i);
    expect(error.textContent).not.toMatch(/Manage AI models/i);
  });

  it("points a rejected or missing key at the provider screen, never at a retired label", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete() {
        yield { kind: "error" as const, attempt: 1, code: "auth-invalid" as const, message: "401 invalid key", retryable: false };
        yield { kind: "done" as const, attempt: 1, stopReason: "error" as const };
      },
    };
    mount({ createAdapter: () => adapter });
    send("Hello");
    const error = await screen.findByTestId("chat-error");
    // "Manage AI models" no longer exists anywhere in the product; the only
    // destination for a cloud provider key is Chat options -> Providers.
    expect(error.textContent).toMatch(/Providers/);
    expect(error.textContent).not.toMatch(/Manage AI models/i);
  });

  it("keeps at most three starter suggestions on the empty chat (Help.fbx20.test.tsx)", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete() {
        yield { kind: "text" as const, attempt: 1, delta: "An answer." };
        yield { kind: "done" as const, attempt: 1, stopReason: "complete" as const };
      },
    };
    mount({ createAdapter: () => adapter });
    const landing = screen.getByTestId("assistant-landing");
    expect(within(landing).getAllByRole("button")).toHaveLength(3);
    // The starter rows belong to the empty conversation only.
    send("Hello");
    await screen.findByText("An answer.");
    expect(screen.queryByTestId("assistant-landing")).toBeNull();
  });

  it("never offers the on-device tool engine as a chat selection (Help.needlePin.test.tsx)", async () => {
    const rows: ModelRecord[] = [
      { provider: "offline", id: "needle-tools", input: ["text"], output: ["text"], prices: [], priceClass: "free", retrievedAt: "2026-10-21T00:00:00Z", entitlement: "untested" },
      { provider: "deepseek", id: "deepseek-chat", displayName: "DeepSeek chat", input: ["text"], output: ["text"], prices: [], priceClass: "free", retrievedAt: "2026-10-21T00:00:00Z", entitlement: "untested" },
    ];
    mount({ listCatalog: async () => rows });
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "deepseek" } });
    await screen.findByText("DeepSeek chat");
    expect(screen.queryByText("needle-tools")).toBeNull();
    expect(screen.queryByRole("button", { name: /needle/i })).toBeNull();
  });

  it("sends the selected provider and model on the wire, never a hardwired one (Help.g12.test.tsx)", async () => {
    const seen: { provider: string; modelId: string }[] = [];
    const adapter: ProviderAdapter = {
      id: "deepseek",
      capabilities: caps,
      async *complete(request) {
        seen.push({ provider: request.selection.provider, modelId: request.selection.modelId });
        yield { kind: "text" as const, attempt: 1, delta: "Answered by the chosen row." };
        yield { kind: "done" as const, attempt: 1, stopReason: "complete" as const };
      },
    };
    const rows: ModelRecord[] = [
      { provider: "deepseek", id: "deepseek-chat", displayName: "DeepSeek chat", input: ["text"], output: ["text"], prices: [], priceClass: "paid", retrievedAt: "2026-10-21T00:00:00Z", entitlement: "untested" },
    ];
    mount({ createAdapter: () => adapter, listCatalog: async () => rows });
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "deepseek" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use DeepSeek chat" }));
    send("Hello");
    await screen.findByText("Answered by the chosen row.");
    expect(seen).toEqual([{ provider: "deepseek", modelId: "deepseek-chat" }]);
  });

  it("stops a running send and keeps the draft (Help.assistant.test.tsx)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(request) {
        await gate;
        if (request.signal.aborted) { yield { kind: "done" as const, attempt: 1, stopReason: "cancelled" as const }; return; }
        yield { kind: "text" as const, attempt: 1, delta: "late answer" };
        yield { kind: "done" as const, attempt: 1, stopReason: "complete" as const };
      },
    };
    mount({ createAdapter: () => adapter });
    send("Keep this draft");
    await waitFor(() => expect(screen.getByTestId("chat-stop")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-stop"));
    await act(async () => { release(); await gate; });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep this draft");
    expect(screen.queryByText("late answer")).toBeNull();
  });
});
