// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Help, type HelpAssistantDeps } from "./Help";
import { ChatStore } from "../services/ai/chatStore";
import type { ModelRecord, ProviderAdapter } from "../services/ai/providerContract";
import { resetBackInterceptors } from "../components/backNavigation";

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "cloud-user" } }) }));
// The local/on-device runtime must never be reached from the cloud Chat path.
const local = vi.hoisted(() => ({
  getApplicationAi: vi.fn(() => { throw new Error("Local generation must not be used"); }),
}));
vi.mock("../services/ai/applicationAi", () => local);

beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); resetBackInterceptors(); localStorage.clear(); vi.clearAllMocks(); document.body.style.overflow = ""; });

function mount(overrides: HelpAssistantDeps = {}) {
  const store = new ChatStore();
  const complete = vi.fn<ProviderAdapter["complete"]>(async function* () {
    yield { kind: "text", attempt: 1, delta: "Cloud answer" };
    yield { kind: "done", attempt: 1, stopReason: "complete" };
  });
  const adapter: ProviderAdapter = { id: "openrouter", complete, capabilities: () => ({
    vision: { state: "known", value: false }, maxImagesPerCall: { state: "known", value: 0 },
    contextTokens: { state: "unknown" }, maxOutputTokens: { state: "unknown" }, streaming: { state: "known", value: true },
  }) };
  render(<MemoryRouter><Help deps={{ createStore: () => store, createAdapter: () => adapter, getKey: async () => "test-key", listCatalog: async () => [], ...overrides }} /></MemoryRouter>);
  return { complete, store };
}
function send(text = "How do I search?") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}
const row = (provider: ModelRecord["provider"], priceClass: ModelRecord["priceClass"]): ModelRecord => ({
  provider, id: "same-model", displayName: `${provider} chat`, input: ["text"], output: ["text"],
  prices: [], priceClass, retrievedAt: "2026-10-21T00:00:00Z", entitlement: "untested",
});

describe("packet 11 cloud-only Chat", () => {
  it("offers text Chat without local, photo, automatic or configure controls", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Chat", level: 1 })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.queryByTestId("chat-add-photos")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.queryByText("Configure assistant")).toBeNull();
    expect(local.getApplicationAi).not.toHaveBeenCalled();
  });
  it("keeps a missing-key draft with actionable error, never substitutes FAQ", async () => {
    const { complete, store } = mount({ getKey: async () => null });
    send();
    await screen.findByTestId("chat-error");
    expect(screen.getByTestId("chat-error").textContent).toMatch(/key.*Providers/i);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "How do I search?");
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(store.listChats("cloud-user").flatMap((chat) => chat.turns)).toHaveLength(0);
  });
  it("does not contact a provider while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { complete } = mount();
    send();
    expect(await screen.findByTestId("chat-error")).toHaveProperty("textContent", "You’re offline. Connect to the internet to send a message. Your draft is kept.");
    expect(complete).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it.each(["paid", "unknown", "variable"] as const)("sends a selected %s-price cloud row with its provider", async (price) => {
    const { complete } = mount({ listCatalog: async () => [row("deepseek", price), row("offline", "free")] });
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "deepseek" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use deepseek chat" }));
    send("Hello cloud");
    await screen.findByText("Cloud answer");
    expect(complete.mock.calls[0]?.[0].selection).toMatchObject({ provider: "deepseek", modelId: "same-model" });
    expect(complete.mock.calls[0]?.[0].approvedImageIds).toEqual([]);
    expect(local.getApplicationAi).not.toHaveBeenCalled();
  });
  it("stops a pending key read without sending after it settles", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const getKey = vi.fn(() => pending);
    const { complete } = mount({ getKey });
    send("Keep me");
    await waitFor(() => expect(getKey).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("chat-stop"));
    await act(async () => { resolve("test-key"); await pending; });
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep me");
  });
});
