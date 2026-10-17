// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import { loadAiPreferences } from "../services/ai/aiPreferences";
import type { ProviderAdapter, StreamEvent } from "../services/ai/providerContract";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-intent", username: "tester" } }),
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

function renderHelp(deps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={["/help"]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
        <Route path="/search" element={<p>Search screen</p>} />
        <Route path="/report" element={<p>Report screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Help stored default", () => {
  it("reads the persisted Assistant default (null = Automatic, never a faked choice)", () => {
    renderHelp({ createAdapter: () => cannedAdapter("ok") });
    // No stored choice in this environment → the session seeds to Automatic,
    // not to a resolved model id. A resolved seed would fake a user choice
    // and hide Select buttons in the picker.
    expect(screen.getByRole("button", { name: /choose model/i }).textContent).toMatch(/automatic/i);
  });

});

describe("Help unavailable manual pin: persisted default absent from catalogue", () => {
  function send(text: string) {
    fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: text } });
    fireEvent.submit(screen.getByTestId("chat-composer"));
  }

  it("refuses an unavailable manual pin without silently switching to the free route", async () => {
    const key = "findback.ai.preferences.v1.u-intent";
    window.localStorage.setItem(
      key,
      JSON.stringify({
        assistantMode: "automatic",
        preferredAssistantModel: "groq/paid-row",
        photoEngine: "automatic",
        matchesEngine: "use",
      }),
    );
    try {
      const adapter = cannedAdapter("free answer");
      const complete = vi.spyOn(adapter, "complete");
      const getKey = vi.fn(async () => "test-key");
      renderHelp({ createAdapter: () => adapter, getKey, listCatalog: async () => [] });
      const question = "How do I report?";
      send(question);
      const refusal = await screen.findByTestId("chat-error");
      expect(refusal.textContent).toMatch(/not in the enabled catalogue.*draft is kept/i);
      expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", question);
      expect(screen.getByTestId("chat-retry")).toBeTruthy();
      expect(screen.queryByText("free answer")).toBeNull();
      expect(screen.queryByText("Built-in answer")).toBeNull();
      expect(getKey).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(loadAiPreferences("u-intent").preferredAssistantModel).toBe("groq/paid-row");
    } finally {
      window.localStorage.removeItem(key);
    }
  });
});
