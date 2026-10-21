// @vitest-environment jsdom
// Packet 11 replaces the old photo/local/FAQ assistant. Retained contracts:
// account-scoped history, stop/retry, transcript, composition and navigation.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Help, type HelpAssistantDeps } from "./Help";
import { ChatStore } from "../services/ai/chatStore";
import type { ProviderAdapter } from "../services/ai/providerContract";
import { resetBackInterceptors } from "../components/backNavigation";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "assistant-user" } }) }));
beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); localStorage.clear(); resetBackInterceptors(); document.body.style.overflow = ""; });
function mount(extra: HelpAssistantDeps = {}) {
  const store = new ChatStore();
  const complete = vi.fn<ProviderAdapter["complete"]>(async function* () {
    yield { kind: "text", attempt: 1, delta: "A useful response" };
    yield { kind: "done", attempt: 1, stopReason: "complete" };
  });
  const adapter: ProviderAdapter = { id: "openrouter", complete, capabilities: () => ({ vision: { state: "unknown" }, maxImagesPerCall: { state: "unknown" }, contextTokens: { state: "unknown" }, maxOutputTokens: { state: "unknown" }, streaming: { state: "known", value: true } }) };
  render(<MemoryRouter><Help deps={{ createStore: () => store, createAdapter: () => adapter, getKey: async () => "test-key", ...extra }} /></MemoryRouter>);
  return { store, complete };
}
function send(text = "My first question") {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}
it("preserves history new, continue, rename, search, delete and clear controls", async () => {
  const { store } = mount();
  send(); await screen.findByText("A useful response");
  expect(store.listChats("assistant-user")[0]?.turns).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename My first question" }));
  fireEvent.change(screen.getByLabelText("Chat title"), { target: { value: "Kept chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Save title" }));
  fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "unmatched" } });
  expect(screen.queryByRole("button", { name: "Continue Kept chat" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await screen.findByTestId("assistant-landing");
  fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue Kept chat" }));
  await screen.findByText("A useful response");
  fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Kept chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  expect(store.listChats("assistant-user").some((chat) => chat.title === "Kept chat")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear all chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm clear all" }));
  expect(store.listChats("assistant-user")).toHaveLength(0);
});
it("keeps history-off responses visible without saving them and retries an answer", async () => {
  const { store, complete } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
  fireEvent.click(screen.getByRole("switch", { name: "Chat history" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  send(); await screen.findByText("A useful response");
  expect(store.listChats("assistant-user")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
  await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
});
it("does not submit on IME Enter and keeps the skip link and conversation landmark", () => {
  const { complete } = mount();
  const input = screen.getByLabelText("Message");
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "বাংলা" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.compositionEnd(input);
  expect(input).toHaveProperty("value", "বাংলা");
  expect(complete).not.toHaveBeenCalled();
  expect(screen.getByRole("main", { name: "Chat conversation" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Skip to composer" }).getAttribute("href")).toBe("#help-composer-input");
});
