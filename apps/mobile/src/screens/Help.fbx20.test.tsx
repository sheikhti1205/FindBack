// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import type { ProviderAdapter, StreamEvent } from "../services/ai/providerContract";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-fbx", username: "tester" } }),
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
  try {
    localStorage.clear();
  } catch {
    // Storage unavailable in this runtime; tests do not depend on it.
  }
});

function cannedAdapter(answer: string, onCall?: () => void): ProviderAdapter {
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
      onCall?.();
      yield { kind: "text", attempt: 1, delta: answer };
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    },
  };
}

function renderHelp(deps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={["/help"]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
        <Route path="/search" element={<p>Search screen</p>} />
        <Route path="/report" element={<p>Report screen</p>} />
        <Route path="/profile" element={<p>Profile screen</p>} />
        <Route path="/settings/ai/models" element={<p>Models screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

describe("Help composer chip, configure and retry", () => {
  it("opens conversation directly with no retired Guide modes", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.queryByTestId("assistant-guide")).toBeNull();
  });

  it("keeps at most three starter suggestions on the empty chat", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    expect(screen.getByRole("button", { name: "How do I report a lost item?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "How do I mark an item recovered?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "What details should I include?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "How do I search and filter?" })).toBeNull();
  });

  it("renders the model chip inside the composer, not the header", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    const chip = screen.getByTestId("composer-model-chip");
    expect(chip.closest('[data-testid="chat-composer"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /choose model/i })).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByTestId("model-picker")).toBeTruthy();
  });

  it("regenerates an assistant answer through its per-response Retry", async () => {
    let calls = 0;
    renderHelp({
      getKey: async () => "test-key",
      createAdapter: () => cannedAdapter("ok", () => { calls += 1; }),
    });
    send("How do I report?");
    await screen.findByText("ok");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(screen.getAllByText("ok").length).toBe(2));
  });

  it("opens a separate Configure sheet with a real policy choice", async () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    fireEvent.click(screen.getByRole("button", { name: /configure assistant/i }));
    expect(screen.getByTestId("assistant-configure")).toBeTruthy();
    expect(screen.getByTestId("configure-mode-automatic")).toBeTruthy();
    fireEvent.click(screen.getByTestId("configure-mode-on-device-only"));
    expect(screen.getByTestId("configure-mode-on-device-only").getAttribute("aria-checked")).toBe("true");
    // The conversational choice persists through the canonical store.
    expect(localStorage.getItem("findback.ai.preferences.v1.u-fbx")).toContain("on-device-only");
  });
});
