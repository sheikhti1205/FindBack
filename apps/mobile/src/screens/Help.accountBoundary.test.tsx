// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Help, type HelpAssistantDeps } from "./Help";
import { ChatStore } from "../services/ai/chatStore";
import type { ProviderAdapter } from "../services/ai/providerContract";
import { resetBackInterceptors } from "../components/backNavigation";

const boundary = vi.hoisted(() => ({ account: "account-A" as string | null, choose: vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: boundary.account ? { id: boundary.account } : null }) }));
vi.mock("../services/media/nativeMedia", () => ({ chooseNativeImage: boundary.choose, isNativeMediaIntakeAvailable: () => true }));

beforeEach(() => {
  boundary.account = "account-A";
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:account-photo"), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  resetBackInterceptors();
  boundary.choose.mockReset();
  localStorage.clear();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function adapter(complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { id: "openrouter", complete, capabilities: () => ({
    vision: { state: "known", value: true }, maxImagesPerCall: { state: "known", value: 10 },
    contextTokens: { state: "unknown" }, maxOutputTokens: { state: "unknown" }, streaming: { state: "known", value: true },
  }) };
}
function mount(overrides: HelpAssistantDeps = {}, incoming?: { assistantPrompt: string }) {
  const store = new ChatStore();
  const complete = vi.fn<ProviderAdapter["complete"]>(async function* () {
    yield { kind: "text", attempt: 1, delta: "A private answer" };
    yield { kind: "done", attempt: 1, stopReason: "complete" };
  });
  const deps: HelpAssistantDeps = { createStore: () => store, createAdapter: () => adapter(complete), getKey: async () => "test-key", ...overrides };
  const tree = () => <MemoryRouter initialEntries={[{ pathname: "/help", state: incoming }]}><Help deps={deps} /></MemoryRouter>;
  const view = render(tree());
  return { store, complete, switchAccount(id: string | null) { boundary.account = id; view.rerender(tree()); } };
}
function send(text = "A private question") {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

describe("Help account-owned UI and async lifecycle", () => {
  it("does not consume the retired report handoff into either account's composer", async () => {
    const view = mount({}, { assistantPrompt: "A private route prompt" });
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    view.switchAccount("account-B");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  });

  it.each(["account-B", null])("clears A's unsent draft when identity becomes %s", async (next) => {
    const view = mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A unsent private draft" } });
    view.switchAccount(next);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    expect(screen.queryByTestId("chat-selections")).toBeNull();
  });

  it("aborts A's send and rejects late stream output after B mounts", async () => {
    const gate = deferred<void>();
    let signal: AbortSignal | undefined;
    const complete = vi.fn<ProviderAdapter["complete"]>(async function* (request) {
      signal = request.signal;
      await gate.promise; // deliberately ignores cancellation until settlement
      yield { kind: "text", attempt: 1, delta: "A delayed private answer" };
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    });
    const view = mount({ createAdapter: () => adapter(complete) });
    send();
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    view.switchAccount("account-B");
    await act(async () => { gate.resolve(); await gate.promise; });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/A (delayed private answer|private question)/)).toBeNull();
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    expect(screen.getByTestId("chat-send")).toHaveProperty("disabled", true);
  });

  it("does not start A's transport when a pending key settles after B mounts", async () => {
    const key = deferred<string | null>();
    const getKey = vi.fn(() => key.promise);
    const view = mount({ getKey });
    send();
    await waitFor(() => expect(getKey).toHaveBeenCalled());
    view.switchAccount("account-B");
    await act(async () => { key.resolve("test-key"); await key.promise; });
    expect(view.complete).not.toHaveBeenCalled();
    expect(screen.queryByText("A private answer")).toBeNull();
    expect(screen.queryByText("Built-in answer")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  });

  it("never offers native photo intake in either account", async () => {
    const view = mount();
    expect(screen.queryByTestId("chat-add-photos")).toBeNull();
    view.switchAccount("account-B");
    expect(boundary.choose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-selections")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("retains completed account-scoped history without showing it to the next account", async () => {
    const view = mount();
    send();
    await screen.findByText("A private answer");
    view.switchAccount("account-B");
    await screen.findByTestId("assistant-landing");
    expect(screen.queryByText("A private answer")).toBeNull();
    view.switchAccount("account-A");
    await screen.findByText("A private answer");
    expect(view.store.listChats("account-B")).toHaveLength(0);
  });
});
