// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help, type HelpAssistantDeps } from "./Help";
import { ChatStore } from "../services/ai/chatStore";
import type { ProviderAdapter } from "../services/ai/providerContract";
import { resetBackInterceptors } from "../components/backNavigation";

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "chat-only" } }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function mount(deps: HelpAssistantDeps = {}) {
  const complete = vi.fn<ProviderAdapter["complete"]>(async function* () {
    yield { kind: "text", attempt: 1, delta: "Tell me more about it." };
    yield { kind: "done", attempt: 1, stopReason: "complete" };
  });
  const adapter: ProviderAdapter = {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "known", value: false },
      maxImagesPerCall: { state: "known", value: 0 },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    complete,
  };
  render(<MemoryRouter initialEntries={["/help"]}><Routes>
    <Route path="/help" element={<Help deps={{ createAdapter: () => adapter, getKey: async () => "test-key", ...deps }} />} />
    <Route path="/report" element={<p>Report destination</p>} />
    <Route path="/search" element={<p>Search destination</p>} />
  </Routes></MemoryRouter>);
  return { complete };
}

describe("CF070 Chat has no guided workflow or app actions", () => {
  it("offers conversation, not report creation or Guide tabs", () => {
    mount();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("region", { name: "Quick actions" })).toBeNull();
    expect(screen.queryByTestId(/^guided-shortcut-/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^report a (lost|found) item/i })).toBeNull();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it.each(["I lost my keys", "I found a wallet", "search red backpack"])("keeps %s as a chat draft without app-action proposals", (text) => {
    const { complete } = mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    expect(screen.queryByTestId(/^intent-cta-/)).toBeNull();
    expect(screen.getByRole("textbox")).toHaveProperty("value", text);
    expect(screen.queryByText(/destination$/)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends report-like text as an ordinary conversation without starting a wizard", async () => {
    const { complete } = mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "I lost my keys" } });
    fireEvent.submit(screen.getByTestId("chat-composer"));
    await screen.findByText("Tell me more about it.");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("guided-panel")).toBeNull();
    expect(screen.queryByText(/destination$/)).toBeNull();
  });

  it("preserves legacy saved response text without converting model JSON into application buttons", async () => {
    const store = new ChatStore();
    const chat = store.createChat("chat-only");
    store.appendTurn("chat-only", chat.id, {
      role: "assistant",
      text: '```json\n{"markdown":"Old guidance","actions":[{"id":"OPEN_REPORT","label":"Create this report"}]}\n```',
      attachmentIds: [],
    });
    const { complete } = mount({ createStore: () => store });
    await waitFor(() => expect(screen.getByTestId("chat-transcript").textContent).toContain("Old guidance"));
    expect(screen.queryByRole("button", { name: "Create this report" })).toBeNull();
    expect(screen.getByTestId("chat-transcript").textContent).toContain("OPEN_REPORT");
    expect(complete).not.toHaveBeenCalled();
  });
});
